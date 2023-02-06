## Developing

Run `npm run install-extension` to build and install the extension in your local VSCode. If you run `npm run install-extension --watch` it will rebuild and reinstall on every change, though you'll need to run `Developer: Reload Window` in VSCode to pick up on the changes.

## Publishing

### Getting access

You'll need to do this once ever.

1. Visit [go/vscode-publishing](http://go/vscode-publishing) and follow the
   instructions on how to create an `@google.com` Microsoft account and file a
   ticket to be given access to the Google Azure DevOps group.

2. Ask another Wireit team-member to add you to the `polymer-vscode` Azure DevOps group.
   Wait for an email, and click the "Join" button.

### Creating a personal access token (PAT)

You'll need to do this occasionally, depending the expiration date you set, and
whether you still have access to the PAT.

1. Visit https://dev.azure.com/polymer-vscode/_usersSettings/tokens
2. Click "New Token"
3. Set Name to e.g. "Publish Wireit VSCode extension"
4. Set Organization to "polymer-vscode"
5. Set Expiration to "Custom defined" and set the date for e.g. 1 year
6. Set Scopes to "Custom defined"
7. Click "Show all scopes"
8. Scroll to "Marketplace" and check "Mangage"
9. Click "Create"
10. Copy the token and save it somewhere secure

### Publishing

You'll need to do this every time you publish the extension.

1. `cd wireit/vscode-extension`
2. Edit `built/package.json` to increment the version number according to semver
3. Edit `CHANGELOG.md` to document the changes in the release
4. `npm run package` to build the extension
5. `npm run install-extension` to install a local copy of the extension. Reload
   VSCode, and do a bit of manual testing to be sure that everything is working
   (we have automated testing but it's worth double checking little fit and
   finish details).
6. Send a PR with the above changes, get it reviewed, and merge to `main`.
7. `npx vsce login google`
8. Enter your [PAT](#creating-a-personal-access-token-pat)
9. `npx vsce publish -i built/wireit.vsix`
