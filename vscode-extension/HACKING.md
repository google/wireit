## Developing

Run `npm run install-extension` to build and install the extension in your local VSCode. If you run `npm run install-extension --watch` it will rebuild and reinstall on every change, though you'll need to run `Developer: Reload Window` in VSCode to pick up on the changes.

## Publishing

To publish to the official `Google.wireit` marketplace you'll need to get your Personal Access Token (and your account will have to have the rights for it).

Docs are at https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token and you may be able to get your token from https://dev.azure.com/polymer-vscode/_usersSettings/tokens.

Then run `vsce login google` and paste in your PAT.

Run `npm run install-extension`, reload VSCode, and do a bit of manual testing to be sure that everything is working (we have automated testing but it's worth double checking little fit and finish details).

Then from the `vscode-extension` directory run `vsce publish -i built/wireit.vsix` to publish the extension that you've manually tested.
