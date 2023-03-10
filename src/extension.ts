import * as vscode from "vscode";

const GLOBAL_STATE_ENDPOINT_KEY = "vscode-graphiql_graphqlEndpoint";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-graphiql.openBrowser", async () => {
      const lastUsedEndpoint = context.globalState.get(GLOBAL_STATE_ENDPOINT_KEY, "");
      let graphqlEndpoint = await vscode.window.showQuickPick(["Enter new endpoint", lastUsedEndpoint], {
        ignoreFocusOut: true,
        placeHolder: "Pick a GraphQL endpoint",
      });
      if (graphqlEndpoint === "Enter new endpoint") {
        graphqlEndpoint = await vscode.window.showInputBox({
          placeHolder: "Enter the GraphQL endpoint",
          validateInput: (urlString) => {
            try {
              let url = new URL(urlString);
              return null;
            } catch (e) {
              return "Please enter a valid url";
            }
          },
          ignoreFocusOut: true,
        });
      }
      if (graphqlEndpoint === undefined) {
        vscode.window.showErrorMessage("Can not open GraphiQL without a valid GraphQL endpoint");
      } else {
        context.globalState.update(GLOBAL_STATE_ENDPOINT_KEY, graphqlEndpoint);
        GraphiqlPanel.createOrShow(context.extensionUri, context.globalState);
      }
    })
  );

  if (vscode.window.registerWebviewPanelSerializer) {
    // Make sure we register a serializer in activation event
    vscode.window.registerWebviewPanelSerializer(GraphiqlPanel.viewType, {
      async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, _state: any) {
        // Reset the webview options so we use latest uri for `localResourceRoots`.
        webviewPanel.webview.options = getWebviewOptions(context.extensionUri);
        GraphiqlPanel.revive(webviewPanel, context.extensionUri, context.globalState);
      },
    });
  }
}

function getWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    // Enable javascript in the webview
    enableScripts: true,

    // And restrict the webview to only loading content from our extension's `media` directory.
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
  };
}

/**
 * Manages webview panels
 */
class GraphiqlPanel {
  /**
   * Track the currently panel. Only allow a single panel to exist at a time.
   */
  public static currentPanel: GraphiqlPanel | undefined;

  public static readonly viewType = "vscode-graphiql";

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _graphqlEnpoint: string = "";

  public static createOrShow(extensionUri: vscode.Uri, globalState: vscode.Memento) {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    // If we already have a panel, show it.
    if (GraphiqlPanel.currentPanel) {
      GraphiqlPanel.currentPanel._panel.reveal(column);
      return;
    }

    // Otherwise, create a new panel.
    const panel = vscode.window.createWebviewPanel(
      GraphiqlPanel.viewType,
      "Graphiql",
      column || vscode.ViewColumn.One,
      getWebviewOptions(extensionUri)
    );

    GraphiqlPanel.currentPanel = new GraphiqlPanel(panel, extensionUri, globalState);
  }

  public static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, globalState: vscode.Memento) {
    GraphiqlPanel.currentPanel = new GraphiqlPanel(panel, extensionUri, globalState);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, globalState: vscode.Memento) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._graphqlEnpoint = globalState.get(GLOBAL_STATE_ENDPOINT_KEY, "");

    // Set the webview's initial html content
    const webview = this._panel.webview;
    this._panel.title = "Graphiql";
    this._panel.webview.html = this._getHtmlForWebview(webview);

    // Listen for when the panel is disposed
    // This happens when the user closes the panel or when the panel is closed programmatically
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.command) {
          case "alert":
            vscode.window.showErrorMessage(message.text);
            return;
        }
      },
      null,
      this._disposables
    );
  }

  public dispose() {
    GraphiqlPanel.currentPanel = undefined;

    // Clean up our resources
    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    // Local path to React 18
    const scriptReactPath = vscode.Uri.joinPath(this._extensionUri, "media", "react.production.min.js");
    const scriptReactUri = webview.asWebviewUri(scriptReactPath);
    const scriptReactDomPath = vscode.Uri.joinPath(this._extensionUri, "media", "react-dom.production.min.js");
    const scriptReactDomUri = webview.asWebviewUri(scriptReactDomPath);

    // Local path to Graphiql
    const scriptGraphiqlPath = vscode.Uri.joinPath(this._extensionUri, "media", "graphiql.min.js");
    const scriptGraphiqlUri = webview.asWebviewUri(scriptGraphiqlPath);

    // Local path to Graphiql css styles
    const stylesGraphiqlPath = vscode.Uri.joinPath(this._extensionUri, "media", "graphiql.min.css");
    const stylesGraphiqlUri = webview.asWebviewUri(stylesGraphiqlPath);

    const stylesResetPath = vscode.Uri.joinPath(this._extensionUri, "media", "reset.css");
    const stylesResetUri = webview.asWebviewUri(stylesResetPath);

    const stylesAppPath = vscode.Uri.joinPath(this._extensionUri, "media", "app.css");
    const stylesAppUri = webview.asWebviewUri(stylesAppPath);

    // Use a nonce to only allow specific scripts to be run
    const nonce = getNonce();

    return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<!--
					Use a content security policy to only allow loading images from https or from our extension directory,
					and only allow scripts that have a specific nonce.
				-->
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src *; font-src data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'unsafe-eval';">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link href="${stylesResetUri}" rel="stylesheet">
				<link href="${stylesGraphiqlUri}" rel="stylesheet">
				<link href="${stylesAppUri}" rel="stylesheet">
				<title>Graphiql</title>
				<script nonce="${nonce}" src="${scriptReactUri}"></script>
				<script nonce="${nonce}" src="${scriptReactDomUri}"></script>
			</head>
			<body>
				<div id="graphiql">Loading...</div>
				<script nonce="${nonce}" src="${scriptGraphiqlUri}"></script>
				<script nonce="${nonce}">
					ReactDOM.render(
						React.createElement(GraphiQL, {
							fetcher: GraphiQL.createFetcher({
								url: '${this._graphqlEnpoint}',
							}),
							defaultEditorToolsVisibility: true,
						}),
						document.getElementById('graphiql'),
					);
				</script>
			</body>
			</html>`;
  }
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
