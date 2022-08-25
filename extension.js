// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const  vscode = require('vscode');
const cp = require("child_process");
const os = require("os");

/**
 * @param {vscode.ExtensionContext} context
 */

let settings;
let SUDO_PASSWORD;

let globalContext;
let statusBarItem;

const isRemote = () => {
	return vscode.env.remoteName !== undefined;
}

async function activate(context) {
	
	globalContext = context;

	isRemote() ? vscode.commands.executeCommand("setContext", "save-as-root-on-remote.overwriteCtrlS", true) : vscode.commands.executeCommand("setContext", "save-as-root-on-remote.overwriteCtrlS", false)
	
	settings = vscode.workspace.getConfiguration("save-as-root-on-remote");
	if(settings.get("savePasswordsInFile") === true){
		SUDO_PASSWORD = await handleGetSudoPassword()
	}

	createStatusBarItem()
	handleStatusBarItem()

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with  registerCommand
	// The commandId parameter must match the command field in package.json
	context.subscriptions.push(vscode.commands.registerCommand('save-as-root-on-remote.isRemote', function () {
		// The code you place here will be executed every time your command is executed

		// Display a message box to the user
		vscode.window.showInformationMessage(isRemote() ? "Yes! RemoteName: " + vscode.env.remoteName : "Local");
	}));

	context.subscriptions.push(vscode.commands.registerCommand("save-as-root-on-remote.changeCurrentPassword", function(){
		handleSetSudoPassword()
	}))


	context.subscriptions.push(vscode.commands.registerCommand('save-as-root-on-remote.saveAsRoot', async function () {
		
		const editor = vscode.window.activeTextEditor
        if (editor === undefined) {
            return
        }
        if (!["file", "untitled"].includes(editor.document.uri.scheme)) {
            await vscode.window.showErrorMessage(`scheme ${editor.document.uri.scheme} is not supported.`)
            return
        }
		const filename = vscode.window.activeTextEditor.document.uri.path
		const content = vscode.window.activeTextEditor.document.getText()

		if (editor.document.isUntitled) {
			const input = await vscode.window.showSaveDialog({})
			if (input === undefined) {
				return
			}
			await sudoWriteFile(filename, content)

			const column = editor.viewColumn

			// Clear the content of the editor so that the save dialog won't be displayed when executing `workbench.action.closeActiveEditor`.
			await editor.edit((editBuilder) => editBuilder.delete(new vscode.Range(0, 0, editor.document.lineCount, 0)))

			// Close the editor for the untitled file
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor")

			// Open the newly created file
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.window.activeTextEditor.document.uri.path), column)
		}else {
			// Write the editor content to the file
			await sudoWriteFile(filename, content)

			// Reload the file contents from the file system
			await vscode.commands.executeCommand("workbench.action.files.revert")
		}
	}))

    const sudoWriteFile = async (filename, content) => {
		return new Promise(async (resolve, reject) => {
		
		let firstPasswordTry = true;

		if(settings.get("savePasswordsInFile") !== true && SUDO_PASSWORD === undefined){
			SUDO_PASSWORD = await vscode.window.showInputBox({
				prompt: "Enter sudo password",
				password: true,
				placeHolder: "Password of " + os.userInfo().username
			})
		}else if(settings.get("savePasswordsInFile") === true && SUDO_PASSWORD === undefined){
			SUDO_PASSWORD = await handleSetSudoPassword()
		}
		
		handleStatusBarItem()
		cp.exec('test -w ' + filename +'; echo "$?"', function(error, stdout, stderr) {
			if (error) {
				console.error(`exec error: ${error}`);
				reject();
			}
			if(stdout == "1\n") {
				const p = cp.execFile("sudo", ["-S", "-k", "-p", "password:", `filename=${filename}`, "sh", "-c", 'echo "file contents:" >&2; cat <&0 > "$filename"']);

				p.on("error", (err) => {
					console.log(err)
					reject();
				})

				p.stderr?.on("data", async (data) => {
					const lines = data.toString().split("\n").map((line) => line.trim())
					if(lines.includes("password:")) {
						if(firstPasswordTry === false){
							handleClearSudoPassword()
							handleStatusBarItem()
							if(settings.get("savePasswordsInFile") !== true){
								SUDO_PASSWORD = await vscode.window.showInputBox({
									prompt: "Enter sudo password",
									password: true,
									placeHolder: "Password of " + os.userInfo().username
								})
								firstPasswordTry = false;
								p.stdin.write(`${SUDO_PASSWORD}\n`);
							}else if(settings.get("savePasswordsInFile") === true){
								SUDO_PASSWORD = await handleSetSudoPassword()
								p.stdin.write(`${SUDO_PASSWORD}\n`);
							}
						}else{
							p.stdin.write(`${SUDO_PASSWORD}\n`);
							firstPasswordTry = false;
						}
					}else if(lines.includes("file contents:")) {
						p.stdin?.write(content);
						p.stdin?.end();
						stderr += lines.slice(lines.lastIndexOf("file contents:") + 1).join("\n")
					}else if(lines.includes("sudo: 3 incorrect password attempts")) {
						handleClearSudoPassword()
						handleStatusBarItem()
						vscode.window.showErrorMessage("Incorrect password");
						reject();
					}else{
						stderr += data.toString()
					}
				})

				p.on("exit", (code) => {
					if(code == 0) {
						handleStatusBarItem()
						resolve();
					}else{
						reject();
					}
				})
			}
		})
	})
    };

	
    vscode.workspace.onWillSaveTextDocument( async function(e) {
		const editor = vscode.window.activeTextEditor
        if (editor === undefined) {
            return
        }
        if (!["file", "untitled"].includes(editor.document.uri.scheme)) {
            await vscode.window.showErrorMessage(`scheme ${editor.document.uri.scheme} is not supported.`)
            return
        }
		try{

			const filename = e.document.uri.path
			const content = vscode.window.activeTextEditor.document.getText()

			if (editor.document.isUntitled) {
				const input = await vscode.window.showSaveDialog({})
                if (input === undefined) {
                    return
                }
				await sudoWriteFile(filename, content)

				const column = editor.viewColumn

                // Clear the content of the editor so that the save dialog won't be displayed when executing `workbench.action.closeActiveEditor`.
                await editor.edit((editBuilder) => editBuilder.delete(new vscode.Range(0, 0, editor.document.lineCount, 0)))

                // Close the editor for the untitled file
                await vscode.commands.executeCommand("workbench.action.closeActiveEditor")

                // Open the newly created file
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(e.document.uri.path), column)
			}else {
                // Write the editor content to the file
				await sudoWriteFile(filename, content)

                // Reload the file contents from the file system
                await vscode.commands.executeCommand("workbench.action.files.revert")
            }

		} catch (err) {
            // Handle errors
            if (err instanceof vscode.CancellationError) {
                return
            }
            console.error(err)
            await vscode.window.showErrorMessage(`[Save as Root] ${/** @type {Error} */(err).message}`)
        }
	
    });

}

const createStatusBarItem = async () => {
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
	statusBarItem.accessibilityInformation = {
		label: "Save as Root"
	}
	statusBarItem.command = "save-as-root-on-remote.saveAsRoot"
	statusBarItem.show()
}
const handleStatusBarItem = async () => {
	if(isRemote() === true){
		if(SUDO_PASSWORD != null ){
			statusBarItem.text = "$(workspace-trusted)"
			statusBarItem.tooltip = "Save as Root - Password known"
			statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.background')
		}else {
			statusBarItem.text = "$(workspace-untrusted)"
			statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
			statusBarItem.tooltip = "Save as Root - Password unknown"
		}
	}
}

const handleClearSudoPassword = async () => {
	SUDO_PASSWORD = null
	globalContext["secrets"].delete(vscode.env.machineId)
}

const handleSetSudoPassword = async() => {
	SUDO_PASSWORD = await vscode.window.showInputBox({
		prompt: "Enter sudo password",
		password: true,
		placeHolder: "Password of " + os.userInfo().username
	})
	if(SUDO_PASSWORD != null){
		globalContext["secrets"].store(vscode.env.machineId, SUDO_PASSWORD)
	}
	return SUDO_PASSWORD
}

const handleGetSudoPassword = async () =>{
	let host = vscode.env.machineId;
	const SecretStorage = globalContext["secrets"];
	if(SecretStorage.get(host) != null){
		return SecretStorage.get(host)
	}


	return undefined
}

// this method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate
}
