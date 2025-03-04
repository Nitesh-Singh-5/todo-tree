/* jshint esversion:6 */

var vscode = require( 'vscode' );
var ripgrep = require( './ripgrep' );
var path = require( 'path' );
var treeify = require( 'treeify' );
var fs = require( 'fs' );
var crypto = require( 'crypto' );

var tree = require( "./tree.js" );
var colours = require( './colours.js' );
var highlights = require( './highlights.js' );
var config = require( './config.js' );
var utils = require( './utils.js' );
var attributes = require( './attributes.js' );

var searchResults = [];
var searchList = [];
var currentFilter;
var interrupted = false;
var selectedDocument;
var refreshTimeout;
var fileRefreshTimeout;
var fileWatcherTimeout;
var hideTimeout;
var openDocuments = {};
var provider;
var ignoreMarkdownUpdate = false;
var markdownUpdatePopupOpen = false;

var SCAN_MODE_WORKSPACE_AND_OPEN_FILES = 'workspace';
var SCAN_MODE_OPEN_FILES = 'open files';
var SCAN_MODE_CURRENT_FILE = 'current file';
var SCAN_MODE_WORKSPACE_ONLY = 'workspace only';

var STATUS_BAR_TOTAL = 'total';
var STATUS_BAR_TAGS = 'tags';
var STATUS_BAR_TOP_THREE = 'top three';
var STATUS_BAR_CURRENT_FILE = 'current file';

var MORE_INFO_BUTTON = "More Info";
var YES_BUTTON = "Yes";
var NEVER_SHOW_AGAIN_BUTTON = "Never Show This Again";
var OPEN_SETTINGS_BUTTON = "Open Settings";

function activate( context )
{
    var outputChannel;

    function debug( text )
    {
        if( outputChannel )
        {
            var now = new Date();
            outputChannel.appendLine( now.toLocaleTimeString( 'en', { hour12: false } ) + "." + String( now.getMilliseconds() ).padStart( 3, '0' ) + " " + text );
        }
    }

    var buildCounter = context.workspaceState.get( 'buildCounter', 1 );
    context.workspaceState.update( 'buildCounter', ++buildCounter );

    currentFilter = context.workspaceState.get( 'currentFilter' );

    config.init( context );
    highlights.init( context, debug );
    utils.init( config );
    attributes.init( config );

    provider = new tree.TreeNodeProvider( context, debug, setButtonsAndContext );
    var status = vscode.window.createStatusBarItem( vscode.StatusBarAlignment.Left, 0 );

    var todoTreeView = vscode.window.createTreeView( "todo-tree-view", { treeDataProvider: provider } );

    var fileSystemWatcher;

    context.subscriptions.push( provider );
    context.subscriptions.push( status );
    context.subscriptions.push( todoTreeView );

    context.subscriptions.push( vscode.workspace.registerTextDocumentContentProvider( 'todotree-export', {
        provideTextDocumentContent( uri )
        {
            if( path.extname( uri.path ) === '.json' )
            {
                return JSON.stringify( provider.exportTree(), null, 2 );
            }
            return treeify.asTree( provider.exportTree(), true );
        }
    } ) );

    ignoreMarkdownUpdate = context.globalState.get( 'ignoreMarkdownUpdate', false );

    function resetOutputChannel()
    {
        if( outputChannel )
        {
            outputChannel.dispose();
            outputChannel = undefined;
        }
        if( vscode.workspace.getConfiguration( 'todo-tree.general' ).debug === true )
        {
            outputChannel = vscode.window.createOutputChannel( "Todo Tree" );
        }
    }

    function resetFileSystemWatcher()
    {
        function checkForExternalFileChanged( uri )
        {
            debug( uri.fsPath + " changed" );
            removeFileFromSearchResults( uri.fsPath );
            provider.remove( null, uri.fsPath );
            searchList.push( uri.fsPath );
            searchList = searchList.filter( function( element, index )
            {
                return searchList.indexOf( element ) == index;
            } );
            clearTimeout( fileWatcherTimeout );
            fileWatcherTimeout = setTimeout( iterateSearchList, 500 );
        }

        if( fileSystemWatcher )
        {
            fileSystemWatcher.dispose();
            fileSystemWatcher = undefined;
        }

        if( config.scanMode() === SCAN_MODE_WORKSPACE_AND_OPEN_FILES )
        {
            if( vscode.workspace.getConfiguration( 'todo-tree.general' ).enableFileWatcher === true )
            {
                var glob = vscode.workspace.getConfiguration( 'todo-tree.general' ).fileWatcherGlob;

                fileSystemWatcher = vscode.workspace.createFileSystemWatcher( glob );

                context.subscriptions.push( fileSystemWatcher );

                fileSystemWatcher.onDidChange( checkForExternalFileChanged );
                fileSystemWatcher.onDidCreate( checkForExternalFileChanged );

                fileSystemWatcher.onDidDelete( function( uri )
                {
                    debug( uri.fsPath + " deleted" );
                    removeFileFromSearchResults( uri.fsPath );
                    provider.remove( refreshTree, uri.fsPath );
                } );
            }
        }
    }

    function refreshTree()
    {
        clearTimeout( refreshTimeout );
        refreshTimeout = setTimeout( function()
        {
            provider.refresh();
            setButtonsAndContext();
        }, 200 );
    }

    function addResultsToTree()
    {
        searchResults.map( function( match )
        {
            if( match.added !== true )
            {
                if( path.extname( match.file ) === '.md' )
                {
                    checkForMarkdownUpgrade();
                }
                provider.add( match );
                match.added = true;
            }
        } );

        if( interrupted === false )
        {
            updateStatusBarAndTitleBar();
        }

        provider.filter( currentFilter );
        refreshTree();
    }

    function updateStatusBarAndTitleBar()
    {
        var statusBar = vscode.workspace.getConfiguration( 'todo-tree.general' ).statusBar;
        var fileFilter;
        if( statusBar === STATUS_BAR_CURRENT_FILE )
        {
            if( vscode.window.activeTextEditor && vscode.window.activeTextEditor.document )
            {
                fileFilter = vscode.window.activeTextEditor.document.fileName;
            }
        }

        var counts = provider.getTagCountsForStatusBar( fileFilter );
        var total = Object.values( counts ).reduce( function( a, b ) { return a + b; }, 0 );

        var countRegex = new RegExp( "([^(]*)(\\(\\d+\\))*" );
        var match = countRegex.exec( todoTreeView.title );
        if( match !== null )
        {
            var title = match[ 1 ];
            if( total > 0 )
            {
                title += " (" + total + ")";
            }
            todoTreeView.title = title;
        }

        if( statusBar === STATUS_BAR_TOTAL )
        {
            status.text = "$(check) " + total;
            status.tooltip = "Todo-Tree total";
            status.show();
        }
        else if( statusBar === STATUS_BAR_TAGS || statusBar === STATUS_BAR_CURRENT_FILE || statusBar === STATUS_BAR_TOP_THREE )
        {
            var sortedTags = Object.keys( counts );
            sortedTags.sort( function( a, b ) { return counts[ a ] < counts[ b ] ? 1 : counts[ b ] < counts[ a ] ? -1 : a > b ? 1 : -1; } );
            if( statusBar === STATUS_BAR_TOP_THREE )
            {
                sortedTags = sortedTags.splice( 0, 3 );
            }
            var text = "";
            sortedTags.map( function( tag )
            {
                if( text.length > 0 )
                {
                    text += ", ";
                }
                text += tag + ": " + counts[ tag ];
            } );
            status.text = "$(check) " + text.trim();
            if( statusBar === STATUS_BAR_CURRENT_FILE )
            {
                status.tooltip = "Todo-Tree tags counts in current file";
            }
            else if( statusBar === STATUS_BAR_TOP_THREE )
            {
                status.tooltip = "Todo-Tree top three tag counts";
            }
            else
            {
                status.tooltip = "Todo-Tree tags counts";
            }
            if( Object.keys( counts ).length === 0 )
            {
                status.text += "0";
            }
            status.show();
        }
        else
        {
            status.hide();
        }

        var scanMode = config.scanMode();
        if( scanMode === SCAN_MODE_OPEN_FILES )
        {
            status.text += " (in open files)";
        }
        else if( scanMode === SCAN_MODE_CURRENT_FILE )
        {
            status.text += " (in current file)";
        }

        status.command = "todo-tree.onStatusBarClicked";
    }

    function onStatusBarClicked()
    {
        if( config.clickingStatusBarShouldRevealTree() )
        {
            if( todoTreeView.visible === false )
            {
                vscode.commands.executeCommand( 'todo-tree-view.focus' );
            }
        }
        else
        {
            var setting = vscode.workspace.getConfiguration( 'todo-tree.general' ).statusBar;
            if( setting === STATUS_BAR_TOTAL )
            {
                setting = STATUS_BAR_TAGS;
                vscode.window.showInformationMessage( "Todo Tree: Now showing tag counts" );
            }
            else if( setting === STATUS_BAR_TAGS )
            {
                setting = STATUS_BAR_TOP_THREE;
                vscode.window.showInformationMessage( "Todo Tree: Now showing top three tag counts" );
            }
            else if( setting === STATUS_BAR_TOP_THREE )
            {
                setting = STATUS_BAR_CURRENT_FILE;
                vscode.window.showInformationMessage( "Todo Tree: Now showing total tags in current file" );
            }
            else
            {
                setting = STATUS_BAR_TOTAL;
                vscode.window.showInformationMessage( "Todo Tree: Now showing total tags" );
            }
            vscode.workspace.getConfiguration( 'todo-tree.general' ).update( 'statusBar', setting, true );
        }
    }

    function removeFileFromSearchResults( filename )
    {
        searchResults = searchResults.filter( match =>
        {
            return match.file !== filename;
        } );
    }

    function search( options, done )
    {
        function onComplete()
        {
            if( done )
            {
                done();
            }
        }

        debug( "Searching " + options.filename + "..." );

        ripgrep.search( "/", options ).then( matches =>
        {
            if( matches.length > 0 )
            {
                matches.forEach( match =>
                {
                    debug( " Match (File): " + JSON.stringify( match ) );
                    searchResults.push( match );
                } );
            }
            else if( options.filename )
            {
                removeFileFromSearchResults( options.filename );
            }

            onComplete();
        } ).catch( e =>
        {
            var message = e.message;
            if( e.stderr )
            {
                message += " (" + e.stderr + ")";
            }
            vscode.window.showErrorMessage( "todo-Tree: " + message );
            onComplete();
        } );
    }

    function addGlobs( source, target, exclude )
    {
        Object.keys( source ).map( function( glob )
        {
            if( source.hasOwnProperty( glob ) && source[ glob ] === true )
            {
                target = target.concat( ( exclude === true ? '!' : '' ) + glob );
            }
        } );

        return target;
    }

    function buildGlobsForRipgrep( includeGlobs, excludeGlobs, tempIncludeGlobs, tempExcludeGlobs, submoduleExcludeGlobs )
    {
        var globs = []
            .concat( includeGlobs )
            .concat( tempIncludeGlobs )
            .concat( excludeGlobs.map( g => `!${g}` ) )
            .concat( tempExcludeGlobs.map( g => `!${g}` ) );

        if( config.shouldUseBuiltInFileExcludes() )
        {
            globs = addGlobs( vscode.workspace.getConfiguration( 'files.exclude' ), globs, true );
        }

        if( config.shouldUseBuiltInSearchExcludes() )
        {
            globs = addGlobs( vscode.workspace.getConfiguration( 'search.exclude' ), globs, true );
        }

        if( config.shouldIgnoreGitSubmodules() )
        {
            globs = globs.concat( submoduleExcludeGlobs.map( g => `!${g}` ) );
        }

        return globs;
    }

    function getOptions( filename )
    {
        var c = vscode.workspace.getConfiguration( 'todo-tree' );

        var tempIncludeGlobs = context.workspaceState.get( 'includeGlobs' ) || [];
        var tempExcludeGlobs = context.workspaceState.get( 'excludeGlobs' ) || [];
        var submoduleExcludeGlobs = context.workspaceState.get( 'submoduleExcludeGlobs' ) || [];

        var options = {
            regex: "\"" + utils.getRegexSource() + "\"",
            unquotedRegex: utils.getRegexSource(),
            rgPath: config.ripgrepPath()
        };

        var globs = c.get( 'filtering.passGlobsToRipgrep' ) === true ? buildGlobsForRipgrep(
            c.get( 'filtering.includeGlobs' ),
            c.get( 'filtering.excludeGlobs' ),
            tempIncludeGlobs,
            tempExcludeGlobs,
            submoduleExcludeGlobs ) : undefined;

        if( globs && globs.length > 0 )
        {
            options.globs = globs;
        }
        if( filename )
        {
            options.filename = filename;
        }

        if( context.storageUri.fsPath && !fs.existsSync( context.storageUri.fsPath ) )
        {
            debug( "Attempting to create local storage folder " + context.storageUri.fsPath );
            fs.mkdirSync( context.storageUri.fsPath, { recursive: true } );
        }

        options.outputChannel = outputChannel;
        options.additional = c.get( 'ripgrep.ripgrepArgs' );
        options.maxBuffer = c.get( 'ripgrep.ripgrepMaxBuffer' );
        options.multiline = utils.getRegexSource().indexOf( "\\n" ) > -1;

        if( fs.existsSync( context.storageUri.fsPath ) === true && c.get( 'ripgrep.usePatternFile' ) === true )
        {
            var patternFileName = crypto.randomBytes( 6 ).readUIntLE( 0, 6 ).toString( 36 ) + '.txt';
            options.patternFilePath = path.join( context.storageUri.fsPath, patternFileName );
        }

        if( c.get( 'filtering.includeHiddenFiles' ) )
        {
            options.additional += ' --hidden ';
        }
        if( c.get( 'regex.regexCaseSensitive' ) === false )
        {
            options.additional += ' -i ';
        }

        return options;
    }

    function searchWorkspaces( searchList )
    {
        var scanMode = config.scanMode();
        if( scanMode === SCAN_MODE_WORKSPACE_AND_OPEN_FILES || scanMode === SCAN_MODE_WORKSPACE_ONLY )
        {
            var includes = vscode.workspace.getConfiguration( 'todo-tree.filtering' ).get( 'includedWorkspaces', [] );
            var excludes = vscode.workspace.getConfiguration( 'todo-tree.filtering' ).get( 'excludedWorkspaces', [] );
            if( vscode.workspace.workspaceFolders )
            {
                vscode.workspace.workspaceFolders.map( function( folder )
                {
                    if( folder.uri && folder.uri.scheme === 'file' && utils.isIncluded( folder.uri.fsPath, includes, excludes ) )
                    {
                        searchList.push( folder.uri.fsPath );
                    }
                } );
            }
        }
    }

    function refreshOpenFiles()
    {
        if( config.scanMode() !== SCAN_MODE_WORKSPACE_ONLY )
        {
            Object.keys( openDocuments ).map( function( document )
            {
                refreshFile( openDocuments[ document ] );
            } );
        }
    }

    function applyGlobs()
    {
        var includeGlobs = vscode.workspace.getConfiguration( 'todo-tree.filtering' ).get( 'includeGlobs' );
        var excludeGlobs = vscode.workspace.getConfiguration( 'todo-tree.filtering' ).get( 'excludeGlobs' );

        var tempIncludeGlobs = context.workspaceState.get( 'includeGlobs' ) || [];
        var tempExcludeGlobs = context.workspaceState.get( 'excludeGlobs' ) || [];

        if( includeGlobs.length + excludeGlobs.length + tempIncludeGlobs.length + tempExcludeGlobs.length > 0 )
        {
            debug( "Applying globs to " + searchResults.length + " items..." );

            searchResults = searchResults.filter( function( match )
            {
                return utils.isIncluded( match.file, includeGlobs.concat( tempIncludeGlobs ), excludeGlobs.concat( tempExcludeGlobs ) );
            } );

            debug( "Remaining items: " + searchResults.length );
        }
    }

    function iterateSearchList()
    {
        if( searchList.length > 0 )
        {
            var entry = searchList.pop();
            search( getOptions( entry ), ( searchList.length > 0 ) ? iterateSearchList : function()
            {
                debug( "Found " + searchResults.length + " items" );
                if( vscode.workspace.getConfiguration( 'todo-tree.ripgrep' ).get( 'passGlobsToRipgrep' ) !== true )
                {
                    applyGlobs();
                }
                addResultsToTree();
                setButtonsAndContext();
            } );
        }
        else
        {
            addResultsToTree();
            setButtonsAndContext();
        }
    }

    function getRootFolders()
    {
        var rootFolders = [];
        var valid = true;
        var rootFolder = vscode.workspace.getConfiguration( 'todo-tree.general' ).get( 'rootFolder' );
        if( rootFolder.indexOf( "${workspaceFolder}" ) > -1 )
        {
            if( vscode.workspace.workspaceFolders )
            {
                vscode.workspace.workspaceFolders.map( function( folder )
                {
                    var path = rootFolder;
                    path = path.replace( /\$\{workspaceFolder\}/g, folder.uri.fsPath );
                    rootFolders.push( path );
                } );
            }
            else
            {
                valid = false;
            }
        }
        else if( rootFolder !== "" )
        {
            //Using the VS Code URI api to get the fspath, which will follow case sensitivity of platform
            rootFolders.push( vscode.Uri.file( rootFolder ).fsPath );
        }

        rootFolders.forEach( function( rootFolder )
        {
            rootFolder = utils.replaceEnvironmentVariables( rootFolder );
        } );

        var includes = vscode.workspace.getConfiguration( 'todo-tree.filtering' ).get( 'includedWorkspaces', [] );
        var excludes = vscode.workspace.getConfiguration( 'todo-tree.filtering' ).get( 'excludedWorkspaces', [] );

        if( valid === true )
        {
            rootFolders = rootFolders.filter( function( folder )
            {
                return utils.isIncluded( folder, includes, excludes );
            } );
        }

        return valid === true ? rootFolders : undefined;
    }

    function rebuild()
    {
        todoTreeView.message = "";

        searchResults = [];
        searchList = [];

        provider.clear( vscode.workspace.workspaceFolders );

        interrupted = false;

        status.text = "todo-Tree: Scanning...";
        status.show();
        status.command = "todo-tree.stopScan";
        status.tooltip = "Click to interrupt scan";

        searchList = getRootFolders();

        if( searchList.length === 0 )
        {
            searchWorkspaces( searchList );
        }

        if( config.shouldIgnoreGitSubmodules() )
        {
            submoduleExcludeGlobs = [];
            searchList.forEach( function( rootPath )
            {
                submoduleExcludeGlobs = submoduleExcludeGlobs.concat( utils.getSubmoduleExcludeGlobs( rootPath ) );
            } );
            context.workspaceState.update( 'submoduleExcludeGlobs', submoduleExcludeGlobs );
        }

        iterateSearchList();

        refreshOpenFiles();
    }

    function setButtonsAndContext()
    {
        var c = vscode.workspace.getConfiguration( 'todo-tree' );
        var isTagsOnly = context.workspaceState.get( 'tagsOnly', c.get( 'tree.tagsOnly', false ) );
        var isGroupedByTag = context.workspaceState.get( 'groupedByTag', c.get( 'tree.groupedByTag', false ) );
        var isGroupedBySubTag = context.workspaceState.get( 'groupedBySubTag', c.get( 'tree.groupedBySubTag', false ) );
        var isCollapsible = !isTagsOnly || isGroupedByTag || isGroupedBySubTag;
        var includeGlobs = context.workspaceState.get( 'includeGlobs' ) || [];
        var excludeGlobs = context.workspaceState.get( 'excludeGlobs' ) || [];
        var hasSubTags = provider.hasSubTags();

        var showRevealButton = c.get( 'tree.buttons' ).reveal === true;
        var showScanModeButton = c.get( 'tree.buttons' ).scanMode === true;
        var showViewStyleButton = c.get( 'tree.buttons' ).viewStyle === true;
        var showGroupByTagButton = c.get( 'tree.buttons' ).groupByTag === true;
        var showGroupBySubTagButton = c.get( 'tree.buttons' ).groupBySubTag === true;
        var showFilterButton = c.get( 'tree.buttons' ).filter === true;
        var showRefreshButton = c.get( 'tree.buttons' ).refresh === true;
        var showExpandButton = c.get( 'tree.buttons' ).expand === true;
        var showExportButton = c.get( 'tree.buttons' ).export === true;

        vscode.commands.executeCommand( 'setContext', 'todo-tree-show-reveal-button', showRevealButton && !c.get( 'tree.trackFile', false ) );
        vscode.commands.executeCommand( 'setContext', 'todo-tree-show-scan-mode-button', showScanModeButton );
        vscode.commands.executeCommand( 'setContext', 'todo-tree-show-view-style-button', showViewStyleButton );
        vscode.commands.executeCommand( 'setContext', 'todo-tree-show-group-by-tag-button', showGroupByTagButton );
        vscode.commands.executeCommand( 'setContext', 'todo-tree-show-group-by-sub-tag-button', showGroupBySubTagButton );
        vscode.commands.executeCommand( 'setContext', 'todo-tree-show-filter-button', showFilterButton );
        vscode.commands.executeCommand( 'setContext', 'todo-tree-show-refresh-button', showRefreshButton );
        vscode.commands.executeCommand( 'setContext', 'todo-tree-show-expand-button', showExpandButton );
        vscode.commands.executeCommand( 'setContext', 'todo-tree-show-export-button', showExportButton );

        vscode.commands.executeCommand( 'setContext', 'todo-tree-expanded', context.workspaceState.get( 'expanded', c.get( 'tree.expanded', false ) ) );
        vscode.commands.executeCommand( 'setContext', 'todo-tree-flat', context.workspaceState.get( 'flat', c.get( 'tree.flat', false ) ) );
        vscode.commands.executeCommand( 'setContext', 'todo-tree-tags-only', isTagsOnly );
        vscode.commands.executeCommand( 'setContext', 'todo-tree-grouped-by-tag', isGroupedByTag );
        vscode.commands.executeCommand( 'setContext', 'todo-tree-grouped-by-sub-tag', isGroupedBySubTag );
        vscode.commands.executeCommand( 'setContext', 'todo-tree-filtered', context.workspaceState.get( 'filtered', false ) );
        vscode.commands.executeCommand( 'setContext', 'todo-tree-collapsible', isCollapsible );
        vscode.commands.executeCommand( 'setContext', 'todo-tree-folder-filter-active', includeGlobs.length + excludeGlobs.length > 0 );
        vscode.commands.executeCommand( 'setContext', 'todo-tree-global-filter-active', currentFilter );
        vscode.commands.executeCommand( 'setContext', 'todo-tree-can-toggle-compact-folders', vscode.workspace.getConfiguration( 'explorer' ).compactFolders === true );
        vscode.commands.executeCommand( 'setContext', 'todo-tree-has-sub-tags', hasSubTags );

        vscode.commands.executeCommand( 'setContext', 'todo-tree-scan-mode', config.scanMode() );

        clearTimeout( hideTimeout );
        hideTimeout = setTimeout( hideTreeIfEmpty, 1000 );
    }

    function hideTreeIfEmpty()
    {
        var children = provider.getChildren();
        children = children.filter( function( child )
        {
            return child.isStatusNode !== true;
        } );

        if( vscode.workspace.getConfiguration( 'todo-tree' ).get( "tree.hideTreeWhenEmpty" ) === true )
        {
            vscode.commands.executeCommand( 'setContext', 'todo-tree-is-empty', children.length == 0 );
        }
        else
        {
            vscode.commands.executeCommand( 'setContext', 'todo-tree-is-empty', false );
        }
    }

    function isIncluded( filename )
    {
        var includeGlobs = vscode.workspace.getConfiguration( 'todo-tree.filtering' ).get( 'includeGlobs' );
        var excludeGlobs = vscode.workspace.getConfiguration( 'todo-tree.filtering' ).get( 'excludeGlobs' );
        var includeHiddenFiles = vscode.workspace.getConfiguration( 'todo-tree.filtering' ).get( 'includeHiddenFiles' );

        var tempIncludeGlobs = context.workspaceState.get( 'includeGlobs' ) || [];
        var tempExcludeGlobs = context.workspaceState.get( 'excludeGlobs' ) || [];

        if( config.shouldUseBuiltInFileExcludes() )
        {
            excludeGlobs = addGlobs( vscode.workspace.getConfiguration( 'files.exclude' ), excludeGlobs );
        }

        if( config.shouldUseBuiltInSearchExcludes() )
        {
            excludeGlobs = addGlobs( vscode.workspace.getConfiguration( 'search.exclude' ), excludeGlobs );
        }

        var isHidden = utils.isHidden( filename );
        var included = utils.isIncluded( filename, includeGlobs.concat( tempIncludeGlobs ), excludeGlobs.concat( tempExcludeGlobs ) );

        return included && ( !isHidden || includeHiddenFiles );
    }

    function refreshFile( document )
    {
        function addResult( offset, removeLeadingComments )
        {
            var position = document.positionAt( offset );
            var line = document.lineAt( position.line ).text;
            if( removeLeadingComments === true )
            {
                line = utils.removeLineComments( line, document.fileName );
            }
            return {
                file: document.fileName,
                line: position.line + 1,
                column: position.character + 1,
                match: line
            };
        }

        var matchesFound = false;

        removeFileFromSearchResults( document.fileName );

        if( document.uri.scheme === 'file' && isIncluded( document.fileName ) === true )
        {
            if( config.scanMode() !== SCAN_MODE_CURRENT_FILE || ( vscode.window.activeTextEditor && document.fileName === vscode.window.activeTextEditor.document.fileName ) )
            {
                var extractExtraLines = function( section )
                {
                    result.extraLines.push( addResult( offset, true ) );
                    offset += section.length + 1;
                };
                var isMatch = function( s )
                {
                    if( s.file === result.file && s.line == result.line && s.column == result.column )
                    {
                        found = true;
                    }
                };

                var text = document.getText();
                var regex = utils.getRegexForEditorSearch();

                var match;
                while( ( match = regex.exec( text ) ) !== null )
                {
                    while( text[ match.index ] === '\n' || text[ match.index ] === '\r' )
                    {
                        match.index++;
                        match[ 0 ] = match[ 0 ].substring( 1 );
                    }

                    var offset = match.index;
                    var sections = match[ 0 ].split( "\n" );

                    var result = addResult( offset, false );

                    if( sections.length > 1 )
                    {
                        result.extraLines = [];
                        offset += sections[ 0 ].length + 1;
                        sections.shift();
                        sections.map( extractExtraLines );
                    }

                    var found = false;
                    searchResults.map( isMatch );
                    if( found === false )
                    {
                        debug( " Match (Editor):" + JSON.stringify( result ) );
                        searchResults.push( result );
                        matchesFound = true;
                    }
                }
            }
        }

        if( matchesFound === true )
        {
            provider.reset( document.fileName );
        }
        else
        {
            provider.remove( null, document.fileName );
        }

        addResultsToTree();
    }

    function refresh()
    {
        searchResults.forEach( function( match )
        {
            match.added = false;
        } );
        provider.clear( vscode.workspace.workspaceFolders );
        provider.rebuild();

        refreshOpenFiles();

        addResultsToTree();
        setButtonsAndContext();
    }

    function clearExpansionStateAndRefresh()
    {
        provider.clearExpansionState();
        refresh();
    }

    function showFlatView()
    {
        context.workspaceState.update( 'tagsOnly', false );
        context.workspaceState.update( 'flat', true ).then( refresh );
    }

    function showTagsOnlyView()
    {
        context.workspaceState.update( 'flat', false );
        context.workspaceState.update( 'tagsOnly', true ).then( refresh );
    }

    function showTreeView()
    {
        context.workspaceState.update( 'tagsOnly', false );
        context.workspaceState.update( 'flat', false ).then( refresh );
    }

    function collapse() { context.workspaceState.update( 'expanded', false ).then( clearExpansionStateAndRefresh ); }
    function expand() { context.workspaceState.update( 'expanded', true ).then( clearExpansionStateAndRefresh ); }
    function groupByTag() { context.workspaceState.update( 'groupedByTag', true ).then( refresh ); }
    function ungroupByTag() { context.workspaceState.update( 'groupedByTag', false ).then( refresh ); }
    function groupBySubTag() { context.workspaceState.update( 'groupedBySubTag', true ).then( refresh ); }
    function ungroupBySubTag() { context.workspaceState.update( 'groupedBySubTag', false ).then( refresh ); }

    function clearTreeFilter()
    {
        currentFilter = undefined;
        context.workspaceState.update( 'filtered', false );
        context.workspaceState.update( 'currentFilter', undefined );
        provider.clearTreeFilter();
        refreshTree();
    }

    function addTag( tag )
    {
        var tags = vscode.workspace.getConfiguration( 'todo-tree.general' ).get( 'tags' );
        if( tags.indexOf( tag ) === -1 )
        {
            tags.push( tag );
            vscode.workspace.getConfiguration( 'todo-tree.general' ).update( 'tags', tags, true );
        }
    }

    function addTagDialog()
    {
        vscode.window.showInputBox( { prompt: "New tag", placeHolder: "e.g. FIXME" } ).then( function( tag )
        {
            if( tag )
            {
                addTag( tag );
            }
        } );
    }

    function removeTagDialog()
    {
        var tags = vscode.workspace.getConfiguration( 'todo-tree.general' ).get( 'tags' );
        vscode.window.showQuickPick( tags, { matchOnDetail: true, matchOnDescription: true, canPickMany: true, placeHolder: "Select tags to remove" } ).then( function( tagsToRemove )
        {
            if( tagsToRemove )
            {
                tagsToRemove.map( tag =>
                {
                    tags = tags.filter( t => tag != t );
                } );
                vscode.workspace.getConfiguration( 'todo-tree.general' ).update( 'tags', tags, true );
            }
        } );
    }

    function scanWorkspaceAndOpenFiles()
    {
        vscode.workspace.getConfiguration( 'todo-tree.tree' ).update( 'scanMode', SCAN_MODE_WORKSPACE_AND_OPEN_FILES, vscode.ConfigurationTarget.Workspace );
    }

    function scanOpenFilesOnly()
    {
        vscode.workspace.getConfiguration( 'todo-tree.tree' ).update( 'scanMode', SCAN_MODE_OPEN_FILES, vscode.ConfigurationTarget.Workspace );
    }

    function scanCurrentFileOnly()
    {
        vscode.workspace.getConfiguration( 'todo-tree.tree' ).update( 'scanMode', SCAN_MODE_CURRENT_FILE, vscode.ConfigurationTarget.Workspace );
    }

    function scanWorkspaceOnly()
    {
        vscode.workspace.getConfiguration( 'todo-tree.tree' ).update( 'scanMode', SCAN_MODE_WORKSPACE_ONLY, vscode.ConfigurationTarget.Workspace );
    }

    function dumpFolderFilter()
    {
        debug( "Folder filter include:" + JSON.stringify( context.workspaceState.get( 'includeGlobs' ) ) );
        debug( "Folder filter exclude:" + JSON.stringify( context.workspaceState.get( 'excludeGlobs' ) ) );
    }

    function checkForMarkdownUpgrade()
    {
        if( markdownUpdatePopupOpen === false && ignoreMarkdownUpdate === false )
        {
            var c = vscode.workspace.getConfiguration( 'todo-tree' );
            if( c.get( 'regex.regex' ).indexOf( "|^\\s*- \\[ \\])" ) > -1 )
            {
                markdownUpdatePopupOpen = true;
                setTimeout( function()
                {
                    // Information messages seem to self close after 15 seconds.
                    markdownUpdatePopupOpen = false;
                }, 15000 );
                var message = "Todo Tree: There is now an improved method of locating markdown TODOs.";
                var buttons = [ MORE_INFO_BUTTON, NEVER_SHOW_AGAIN_BUTTON ];
                if( c.get( 'regex.regex' ) === c.inspect( 'regex.regex' ).defaultValue )
                {
                    message += " Would you like to update your settings automatically?";
                    buttons.unshift( YES_BUTTON );
                }
                vscode.window.showInformationMessage( message, ...buttons ).then( function( button )
                {
                    markdownUpdatePopupOpen = false;
                    if( button === undefined )
                    {
                        ignoreMarkdownUpdate = true;
                    }
                    else if( button === YES_BUTTON )
                    {
                        ignoreMarkdownUpdate = true;
                        addTag( '[ ]' );
                        addTag( '[x]' );
                        c.update( 'regex.regex', '(//|#|<!--|;|/\\*|^|^\\s*(-|\\d+.))\\s*($TAGS)', true );
                    }
                    else if( button === MORE_INFO_BUTTON )
                    {
                        vscode.env.openExternal( vscode.Uri.parse( "https://github.com/Gruntfuggly/todo-tree#markdown-support" ) );
                    }
                    else if( button === NEVER_SHOW_AGAIN_BUTTON )
                    {
                        context.globalState.update( 'ignoreMarkdownUpdate', true );
                    }
                } );
            }
        }
    }

    function register()
    {
        function migrateSettings()
        {
            function migrateIfRequired( setting, type, destination )
            {
                function typeMatch( item, type )
                {
                    return typeof ( item ) == type || ( type == 'array' && item && item.length > 0 );
                }

                var details = c.inspect( setting );
                if( typeMatch( details.globalValue, type ) )
                {
                    debug( "Migrating global setting '" + setting + "'" );
                    c.update( destination + "." + setting, details.globalValue, vscode.ConfigurationTarget.Global );
                    migrated = true;
                }
                if( typeMatch( details.workspaceValue, type ) )
                {
                    debug( "Migrating workspace setting '" + setting + "'" );
                    c.update( destination + "." + setting, details.workspaceValue, vscode.ConfigurationTarget.Workspace );
                    migrated = true;
                }
                if( typeMatch( details.workspaceFolderValue, type ) )
                {
                    debug( "Migrating workspaceFolder setting '" + setting + "'" );
                    c.update( destination + "." + setting, details.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder );
                    migrated = true;
                }
            }

            var c = vscode.workspace.getConfiguration( 'todo-tree' );
            var migrated = false;

            migrateIfRequired( 'autoRefresh', 'boolean', 'tree' );
            migrateIfRequired( 'customHighlight', 'object', 'highlights' );
            migrateIfRequired( 'debug', 'boolean', 'general' );
            migrateIfRequired( 'defaultHighlight', 'object', 'highlights' );
            migrateIfRequired( 'excludedWorkspaces', 'array', 'filtering' );
            migrateIfRequired( 'excludeGlobs', 'array', 'filtering' );
            migrateIfRequired( 'expanded', 'boolean', 'tree' );
            migrateIfRequired( 'filterCaseSensitive', 'boolean', 'tree' );
            migrateIfRequired( 'flat', 'boolean', 'tree' );
            migrateIfRequired( 'grouped', 'boolean', 'tree' );
            migrateIfRequired( 'hideIconsWhenGroupedByTag', 'boolean', 'tree' );
            migrateIfRequired( 'hideTreeWhenEmpty', 'boolean', 'tree' );
            migrateIfRequired( 'highlightDelay', 'number', 'highlights' );
            migrateIfRequired( 'includedWorkspaces', 'array', 'filtering' );
            migrateIfRequired( 'includeGlobs', 'array', 'filtering' );
            migrateIfRequired( 'labelFormat', 'string', 'tree' );
            migrateIfRequired( 'passGlobsToRipgrep', 'boolean', 'filtering' );
            migrateIfRequired( 'regex', 'string', 'regex' );
            migrateIfRequired( 'regexCaseSensitive', 'boolean', 'regex' );
            migrateIfRequired( 'revealBehaviour', 'string', 'general' );
            migrateIfRequired( 'ripgrep', 'string', 'ripgrep' );
            migrateIfRequired( 'ripgrepArgs', 'string', 'ripgrep' );
            migrateIfRequired( 'ripgrepMaxBuffer', 'number', 'ripgrep' );
            migrateIfRequired( 'rootFolder', 'string', 'general' );
            migrateIfRequired( 'showBadges', 'boolean', 'tree' );
            migrateIfRequired( 'showCountsInTree', 'boolean', 'tree' );
            migrateIfRequired( 'sortTagsOnlyViewAlphabetically', 'boolean', 'tree' );
            migrateIfRequired( 'statusBar', 'string', 'general' );
            migrateIfRequired( 'statusBarClickBehaviour', 'string', 'general' );
            migrateIfRequired( 'tags', 'array', 'general' );
            migrateIfRequired( 'tagsOnly', 'boolean', 'tree' );
            migrateIfRequired( 'trackFile', 'boolean', 'tree' );

            if( migrated === true )
            {
                if( context.globalState.get( 'migratedVersion', 0 ) < 147 )
                {
                    vscode.window.showInformationMessage( "Your Todo Tree settings have been moved. Please remove the old settings from your settings.json.",
                        OPEN_SETTINGS_BUTTON, NEVER_SHOW_AGAIN_BUTTON ).then( function( button )
                        {
                            if( button === OPEN_SETTINGS_BUTTON )
                            {
                                vscode.commands.executeCommand( 'workbench.action.openSettingsJson', true );
                            }
                            else if( button === NEVER_SHOW_AGAIN_BUTTON )
                            {
                                context.globalState.update( 'migratedVersion', 147 );
                            }
                        } );
                }
            }

            if( context.globalState.get( 'migratedVersion', 0 ) < 168 )
            {
                vscode.workspace.getConfiguration( 'todo-tree.tree' ).update(
                    'showScanModeButton',
                    vscode.workspace.getConfiguration( 'todo-tree.tree' ).showScanOpenFilesOrWorkspaceButton,
                    vscode.ConfigurationTarget.Global );

                if( vscode.workspace.getConfiguration( 'todo-tree.filtering' ).useBuiltInExcludes === true )
                {
                    vscode.workspace.getConfiguration( 'todo-tree.filtering' ).update( 'useBuiltInExcludes', "file excludes", vscode.ConfigurationTarget.Global );
                }

                context.globalState.update( 'migratedVersion', 168 );
            }

            if( context.globalState.get( 'migratedVersion', 0 ) < 189 )
            {
                if( vscode.workspace.getConfiguration( 'todo-tree.tree' ).get( 'showInExplorer' ) === true )
                {
                    vscode.commands.executeCommand( 'vscode.moveViews', {
                        viewIds: [ 'todo-tree-view' ],
                        destinationId: 'workbench.view.explorer'
                    } );

                    vscode.window.showInformationMessage( "Todo-Tree: 'showInExplorer' has been deprecated. If needed, the view can now be dragged to where you want it.", OPEN_SETTINGS_BUTTON, NEVER_SHOW_AGAIN_BUTTON ).then( function( button )
                    {
                        if( button === OPEN_SETTINGS_BUTTON )
                        {
                            vscode.commands.executeCommand( 'workbench.action.openSettingsJson', 'todo-tree.tree.showInExplorer' );
                        }
                        else if( button === NEVER_SHOW_AGAIN_BUTTON )
                        {
                            context.globalState.update( 'migratedVersion', 189 );
                        }
                    } );
                }
            }
        }

        function showInTree( uri )
        {
            provider.getElement( uri.fsPath, function( element )
            {
                if( todoTreeView.visible === true )
                {
                    todoTreeView.reveal( element, { focus: false, select: true } );
                }
            } );
        }

        function documentChanged( document )
        {
            if( document )
            {
                vscode.window.visibleTextEditors.map( editor =>
                {
                    if( document === editor.document && config.shouldShowHighlights( editor.document.uri.scheme ) )
                    {
                        if( document.fileName === undefined || isIncluded( document.fileName ) )
                        {
                            highlights.triggerHighlight( editor );
                        }
                    }
                } );

                if( document.uri.scheme === "file" && path.basename( document.fileName ) !== "settings.json" )
                {
                    if( shouldRefreshFile() )
                    {
                        clearTimeout( fileRefreshTimeout );
                        fileRefreshTimeout = setTimeout( refreshFile, 500, document );
                    }
                }
            }
            else
            {
                vscode.window.visibleTextEditors.map( editor =>
                {
                    if( config.shouldShowHighlights( editor.document.uri.scheme ) )
                    {
                        if( isIncluded( editor.document.fileName ) )
                        {
                            highlights.triggerHighlight( editor );
                        }
                    }
                } );
            }
        }

        function validateColours()
        {
            var invalidColourMessage = colours.validateColours( vscode.workspace );
            if( invalidColourMessage )
            {
                vscode.window.showWarningMessage( "Todo Tree: " + invalidColourMessage );
            }
            var invalidIconColourMessage = colours.validateIconColours( vscode.workspace );
            if( invalidIconColourMessage )
            {
                vscode.window.showWarningMessage( "Todo Tree: " + invalidIconColourMessage );
            }
        }

        function validatePlaceholders()
        {
            var unexpectedPlaceholders = [];
            utils.formatLabel( config.labelFormat(), {}, unexpectedPlaceholders );
            if( unexpectedPlaceholders.length > 0 )
            {
                vscode.window.showErrorMessage( "Todo Tree: Unexpected placeholders (" + unexpectedPlaceholders.join( "," ) + ")" );
            }
        }

        function shouldRefreshFile()
        {
            return vscode.workspace.getConfiguration( 'todo-tree.tree' ).autoRefresh === true && config.scanMode() !== SCAN_MODE_WORKSPACE_ONLY;
        }

        // We can't do anything if we can't find ripgrep
        if( !config.ripgrepPath() )
        {
            vscode.window.showErrorMessage( "todo-Tree: Failed to find vscode-ripgrep - please install ripgrep manually and set 'todo-tree.ripgrep' to point to the executable" );
            return;
        }

        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.revealTodo', ( file, line, column, endColumn ) =>
        {
            selectedDocument = file;
            vscode.workspace.openTextDocument( file ).then( function( document )
            {
                vscode.window.showTextDocument( document ).then( function( editor )
                {
                    var selectionStart, selectionEnd;
                    var todoStart = new vscode.Position( line, column - 1 );
                    var todoEnd = new vscode.Position( line, endColumn - 1 );
                    var lineStart = new vscode.Position( line, 0 );
                    var lineEnd = new vscode.Position( line, document.lineAt( line ).text.length );
                    var revealBehaviour = vscode.workspace.getConfiguration( 'todo-tree.general' ).get( 'revealBehaviour' );

                    if( revealBehaviour == "end of todo" )
                    {
                        selectionStart = todoEnd;
                        selectionEnd = todoEnd;
                    }
                    else if( revealBehaviour == "highlight todo" )
                    {
                        selectionStart = todoStart;
                        selectionEnd = todoEnd;
                    }
                    else if( revealBehaviour == "start of line" )
                    {
                        selectionStart = lineStart;
                        selectionEnd = lineStart;
                    }
                    else if( revealBehaviour == "highlight line" )
                    {
                        selectionStart = lineStart;
                        selectionEnd = lineEnd;
                    }
                    else
                    {
                        selectionStart = todoStart;
                        selectionEnd = todoStart;
                    }

                    editor.selection = new vscode.Selection( selectionStart, selectionEnd );
                    editor.revealRange( editor.selection, vscode.TextEditorRevealType.InCenter );
                    vscode.commands.executeCommand( 'workbench.action.focusActiveEditorGroup' );
                } );
            } );
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.openUrl', ( url ) =>
        {
            debug( "Opening " + url );
            vscode.env.openExternal( vscode.Uri.parse( url ) );
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.filter', function()
        {
            vscode.window.showInputBox( { prompt: "Filter tree" } ).then(
                function( term )
                {
                    currentFilter = term;
                    if( currentFilter )
                    {
                        context.workspaceState.update( 'filtered', true );
                        context.workspaceState.update( 'currentFilter', currentFilter );
                        provider.filter( currentFilter );
                        refreshTree();
                    }
                } );
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.stopScan', function()
        {
            ripgrep.kill();
            status.text = "todo-Tree: Scanning interrupted.";
            status.tooltip = "Click to restart";
            status.command = "todo-tree.refresh";
            interrupted = true;
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.exportTree', function()
        {
            var exportPath = vscode.workspace.getConfiguration( 'todo-tree.general' ).get( 'exportPath' );
            exportPath = utils.replaceEnvironmentVariables( exportPath );
            exportPath = utils.formatExportPath( exportPath );

            var uri = vscode.Uri.parse( 'todotree-export:' + exportPath );
            vscode.workspace.openTextDocument( uri ).then( function( document )
            {
                vscode.window.showTextDocument( document, { preview: true } );
            } );
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.showOnlyThisFolder', function( node )
        {
            var rootNode = tree.locateWorkspaceNode( node.fsPath );
            var includeGlobs = [ utils.createFolderGlob( node.fsPath, rootNode.fsPath, "/*" ) ];
            context.workspaceState.update( 'includeGlobs', includeGlobs );
            rebuild();
            dumpFolderFilter();
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.showOnlyThisFolderAndSubfolders', function( node )
        {
            var rootNode = tree.locateWorkspaceNode( node.fsPath );
            var includeGlobs = [ utils.createFolderGlob( node.fsPath, rootNode.fsPath, "/**/*" ) ];
            context.workspaceState.update( 'includeGlobs', includeGlobs );
            rebuild();
            dumpFolderFilter();
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.excludeThisFolder', function( node )
        {
            var rootNode = tree.locateWorkspaceNode( node.fsPath );
            var glob = utils.createFolderGlob( node.fsPath, rootNode.fsPath, "/**/*" );
            var excludeGlobs = context.workspaceState.get( 'excludeGlobs' ) || [];
            if( excludeGlobs.indexOf( glob ) === -1 )
            {
                excludeGlobs.push( glob );
                context.workspaceState.update( 'excludeGlobs', excludeGlobs );
                rebuild();
                dumpFolderFilter();
            }
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.excludeThisFile', function( node )
        {
            var excludeGlobs = context.workspaceState.get( 'excludeGlobs' ) || [];
            if( excludeGlobs.indexOf( node.fsPath ) === -1 )
            {
                excludeGlobs.push( node.fsPath );
                context.workspaceState.update( 'excludeGlobs', excludeGlobs );
                rebuild();
                dumpFolderFilter();
            }
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.removeFilter', function()
        {
            var CLEAR_TREE_FILTER = "Clear Tree Filter";
            var excludeGlobs = context.workspaceState.get( 'excludeGlobs' ) || [];
            var includeGlobs = context.workspaceState.get( 'includeGlobs' ) || [];
            var choices = [];

            if( currentFilter )
            {
                choices[ CLEAR_TREE_FILTER ] = {};
            }

            excludeGlobs.forEach( function( excludeGlob )
            {
                if( excludeGlob.endsWith( "/**/*" ) )
                {
                    choices[ "Exclude Folder: " + excludeGlob.slice( 0, -5 ) ] = { exclude: excludeGlob };
                }
                else if( excludeGlob.indexOf( '*' ) === -1 )
                {
                    choices[ "Exclude File: " + excludeGlob ] = { exclude: excludeGlob };
                }
                else
                {
                    choices[ "Exclude: " + excludeGlob ] = { exclude: excludeGlob };
                }
            } );
            includeGlobs.forEach( function( includeGlob )
            {
                if( includeGlob.endsWith( "/**/*" ) )
                {
                    choices[ "Include Folder and Subfolders: " + includeGlob.slice( 0, -5 ) ] = { include: includeGlob };
                }
                else if( includeGlob.endsWith( "/*" ) )
                {
                    choices[ "Include Folder: " + includeGlob.slice( 0, -2 ) ] = { include: includeGlob };
                }
                else
                {
                    choices[ "Include: " + includeGlob ] = { include: includeGlob };
                }
            } );

            vscode.window.showQuickPick( Object.keys( choices ), { matchOnDetail: true, matchOnDescription: true, canPickMany: true, placeHolder: "Select filters to remove" } ).then( function( selection )
            {
                if( selection )
                {
                    if( selection.indexOf( CLEAR_TREE_FILTER ) === 0 )
                    {
                        clearTreeFilter();
                        selection.shift();
                    }

                    selection.map( function( choice )
                    {
                        if( choices[ choice ].include )
                        {
                            includeGlobs = includeGlobs.filter( f => choices[ choice ].include != f );
                        }
                        else if( choices[ choice ].exclude )
                        {
                            excludeGlobs = excludeGlobs.filter( f => choices[ choice ].exclude != f );
                        }
                    } );

                    context.workspaceState.update( 'includeGlobs', includeGlobs );
                    context.workspaceState.update( 'excludeGlobs', excludeGlobs );

                    rebuild();
                    dumpFolderFilter();
                }
            } );
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.resetCache', function()
        {
            function purgeFolder( folder )
            {
                fs.readdir( folder, function( err, files )
                {
                    files.map( function( file )
                    {
                        fs.unlinkSync( path.join( folder, file ) );
                    } );
                } );
            }

            context.workspaceState.update( 'includeGlobs', [] );
            context.workspaceState.update( 'excludeGlobs', [] );
            context.workspaceState.update( 'expandedNodes', {} );
            context.workspaceState.update( 'submoduleExcludeGlobs', [] );
            context.workspaceState.update( 'buildCounter', undefined );
            context.workspaceState.update( 'currentFilter', undefined );
            context.workspaceState.update( 'filtered', undefined );
            context.workspaceState.update( 'tagsOnly', undefined );
            context.workspaceState.update( 'flat', undefined );
            context.workspaceState.update( 'expanded', undefined );
            context.workspaceState.update( 'grouped', undefined );
            context.globalState.update( 'migratedVersion', undefined );
            context.globalState.update( 'ignoreMarkdownUpdate', undefined );

            purgeFolder( context.storageUri.fsPath );
            purgeFolder( context.globalStorageUri.fsPath );
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.resetAllFilters', function()
        {
            context.workspaceState.update( 'includeGlobs', [] );
            context.workspaceState.update( 'excludeGlobs', [] );
            rebuild();
            dumpFolderFilter();
            clearTreeFilter();
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.reveal', function()
        {
            if( vscode.window.activeTextEditor )
            {
                showInTree( vscode.window.activeTextEditor.document.uri );
            }
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.toggleItemCounts', function()
        {
            var current = vscode.workspace.getConfiguration( 'todo-tree.tree' ).get( 'showCountsInTree' );
            vscode.workspace.getConfiguration( 'todo-tree.tree' ).update( 'showCountsInTree', !current, vscode.ConfigurationTarget.Workspace );
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.toggleBadges', function()
        {
            var current = vscode.workspace.getConfiguration( 'todo-tree.tree' ).get( 'showBadges' );
            vscode.workspace.getConfiguration( 'todo-tree.tree' ).update( 'showBadges', !current, vscode.ConfigurationTarget.Workspace );
        } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.toggleCompactFolders', function()
        {
            var current = vscode.workspace.getConfiguration( 'todo-tree.tree' ).get( 'disableCompactFolders' );
            vscode.workspace.getConfiguration( 'todo-tree.tree' ).update( 'disableCompactFolders', !current, vscode.ConfigurationTarget.Workspace );
        } ) );

        context.subscriptions.push( todoTreeView.onDidExpandElement( function( e ) { provider.setExpanded( e.element.fsPath, true ); } ) );
        context.subscriptions.push( todoTreeView.onDidCollapseElement( function( e ) { provider.setExpanded( e.element.fsPath, false ); } ) );

        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.filterClear', clearTreeFilter ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.refresh', rebuild ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.showFlatView', showFlatView ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.showTagsOnlyView', showTagsOnlyView ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.showTreeView', showTreeView ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.expand', expand ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.collapse', collapse ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.groupByTag', groupByTag ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.ungroupByTag', ungroupByTag ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.groupBySubTag', groupBySubTag ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.ungroupBySubTag', ungroupBySubTag ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.addTag', addTagDialog ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.removeTag', removeTagDialog ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.onStatusBarClicked', onStatusBarClicked ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.scanWorkspaceAndOpenFiles', scanWorkspaceAndOpenFiles ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.scanOpenFilesOnly', scanOpenFilesOnly ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.scanCurrentFileOnly', scanCurrentFileOnly ) );
        context.subscriptions.push( vscode.commands.registerCommand( 'todo-tree.scanWorkspaceOnly', scanWorkspaceOnly ) );

        context.subscriptions.push( vscode.window.onDidChangeActiveTextEditor( function( e )
        {
            if( e && e.document )
            {
                openDocuments[ e.document.fileName ] = e.document;

                if( config.scanMode() === SCAN_MODE_CURRENT_FILE )
                {
                    provider.clear( vscode.workspace.workspaceFolders );
                    refreshFile( e.document );
                }

                if( vscode.workspace.getConfiguration( 'todo-tree.tree' ).autoRefresh === true && vscode.workspace.getConfiguration( 'todo-tree.tree' ).trackFile === true )
                {
                    if( e.document.uri && e.document.uri.scheme === "file" )
                    {
                        if( selectedDocument !== e.document.fileName )
                        {
                            setTimeout( showInTree, 500, e.document.uri );
                        }
                        selectedDocument = undefined;
                    }
                }

                if( e.document.fileName === undefined || isIncluded( e.document.fileName ) )
                {
                    updateStatusBarAndTitleBar();
                }

                documentChanged( e.document );
            }
        } ) );

        context.subscriptions.push( vscode.workspace.onDidSaveTextDocument( document =>
        {
            if( document.uri.scheme === "file" && path.basename( document.fileName ) !== "settings.json" )
            {
                if( shouldRefreshFile() )
                {
                    refreshFile( document );
                }
            }
        } ) );

        context.subscriptions.push( vscode.workspace.onDidOpenTextDocument( document =>
        {
            if( shouldRefreshFile() )
            {
                if( document.uri.scheme === "file" )
                {
                    openDocuments[ document.fileName ] = document;
                    refreshFile( document );
                }
            }
        } ) );

        context.subscriptions.push( vscode.workspace.onDidCloseTextDocument( document =>
        {
            function removeFromTree( filename )
            {
                removeFileFromSearchResults( filename );
                provider.remove( function()
                {
                    refreshTree();
                    updateStatusBarAndTitleBar();
                }, filename );
            }

            delete openDocuments[ document.fileName ];

            if( vscode.workspace.getConfiguration( 'todo-tree.tree' ).autoRefresh === true )
            {
                if( document.uri.scheme === "file" )
                {
                    if( config.scanMode() !== SCAN_MODE_WORKSPACE_AND_OPEN_FILES )
                    {
                        removeFromTree( document.fileName );
                    }
                    else
                    {
                        var keep = false;
                        var tempSearchList = getRootFolders();

                        if( tempSearchList.length === 0 )
                        {
                            searchWorkspaces( tempSearchList );
                        }

                        tempSearchList.map( function( p )
                        {
                            if( document.fileName === p || document.fileName.indexOf( p + path.sep ) === 0 )
                            {
                                keep = true;
                            }
                        } );
                        if( !keep )
                        {
                            removeFromTree( document.fileName );
                        }
                    }
                }
            }
        } ) );

        context.subscriptions.push( vscode.workspace.onDidChangeConfiguration( function( e )
        {
            if( e.affectsConfiguration( "todo-tree" ) ||
                e.affectsConfiguration( 'files.exclude' ) ||
                e.affectsConfiguration( 'explorer.compactFolders' ) )
            {
                if( e.affectsConfiguration( "todo-tree.regex.regex" ) )
                {
                    return;
                }

                if( e.affectsConfiguration( "todo-tree.highlights.enabled" ) ||
                    e.affectsConfiguration( "todo-tree.highlights.useColourScheme" ) ||
                    e.affectsConfiguration( "todo-tree.highlights.foregroundColourScheme" ) ||
                    e.affectsConfiguration( "todo-tree.highlights.backgroundColourScheme" ) ||
                    e.affectsConfiguration( "todo-tree.highlights.defaultHighlight" ) ||
                    e.affectsConfiguration( "todo-tree.highlights.customHighlight" ) )
                {
                    validateColours();
                    documentChanged();
                }
                else if( e.affectsConfiguration( "todo-tree.tree.labelFormat" ) )
                {
                    validatePlaceholders();
                }
                else if( e.affectsConfiguration( "todo-tree.general.debug" ) )
                {
                    resetOutputChannel();
                }
                else if( e.affectsConfiguration( "todo-tree.general.enableFileWatcher" ) ||
                    e.affectsConfiguration( "todo-tree.general.fileWatcherGlob" ) )
                {
                    resetFileSystemWatcher();
                }

                if( e.affectsConfiguration( "todo-tree.general.tagGroups" ) )
                {
                    config.refreshTagGroupLookup();
                    rebuild();
                    documentChanged();
                }
                else if( e.affectsConfiguration( "todo-tree.tree.showCountsInTree" ) ||
                    e.affectsConfiguration( "todo-tree.tree.showBadges" ) )
                {
                    refresh();
                }
                else if( e.affectsConfiguration( "todo-tree.filtering" ) ||
                    e.affectsConfiguration( "todo-tree.regex" ) ||
                    e.affectsConfiguration( "todo-tree.ripgrep" ) ||
                    e.affectsConfiguration( "todo-tree.tree" ) ||
                    e.affectsConfiguration( "todo-tree.general.rootFolder" ) ||
                    e.affectsConfiguration( "todo-tree.general.tags" ) ||
                    e.affectsConfiguration( "files.exclude" ) )
                {
                    rebuild();
                    documentChanged();
                }
                else
                {
                    refresh();
                }

                setButtonsAndContext();
            }
        } ) );

        context.subscriptions.push( vscode.workspace.onDidChangeWorkspaceFolders( function()
        {
            provider.clear( vscode.workspace.workspaceFolders );
            provider.rebuild();
            rebuild();
        } ) );

        context.subscriptions.push( vscode.workspace.onDidChangeTextDocument( function( e )
        {
            documentChanged( e.document );
        } ) );

        context.subscriptions.push( outputChannel );

        resetOutputChannel();


        migrateSettings();
        validateColours();
        validatePlaceholders();
        setButtonsAndContext();

        if( vscode.workspace.getConfiguration( 'todo-tree.tree' ).scanAtStartup === true )
        {
            rebuild();

            var editors = vscode.window.visibleTextEditors;
            editors.map( function( editor )
            {
                if( editor.document && editor.document.uri.scheme === "file" )
                {
                    openDocuments[ editor.document.fileName ] = editor.document;
                }
                refreshOpenFiles();
            } );

            if( vscode.window.activeTextEditor )
            {
                documentChanged( vscode.window.activeTextEditor.document );
            }

            resetFileSystemWatcher();
        }
        else
        {
            todoTreeView.message = "Click the refresh button to scan...";
        }
    }

    register();
}

function deactivate()
{
    ripgrep.kill();
    provider.clear( [] );
}

exports.activate = activate;
exports.deactivate = deactivate;
