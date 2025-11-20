# JobCompass — Browser Extension

A simple browser extension to assist with interacting with job listing pages.

## Quick start

1. Pull the code to your computer
    - git clone <repository-url>
    - cd <repository-directory>

2. Open Google Chrome Extensions page and enable Developer mode
    - Navigate to chrome://extensions
    - Toggle "Developer mode" on (top-right)

3. Load the extension and pin it
    - Click "Load unpacked" and select the extension folder)
    - After the extension loads, open the Extensions menu (puzzle icon) and click the pin icon next to JobCompass to pin it to the toolbar

4. Use the extension on a job listing page
    - Open any job listing webpage
    - Click the JobCompass icon in the toolbar to activate functionality (collect, highlight, copy, or open the extension UI depending on the build)

## Development notes

- When you make code edits, return to chrome://extensions and click the "Reload" button for the JobCompass entry to pick up changes.
- For console debugging:
  - On the extension card in chrome://extensions click "Service worker" (under "Inspect views") to open DevTools for the service worker and view console logs.
  - For content script debugging, open DevTools on the target page and inspect the Console/Network tabs.

## Troubleshooting

- If "Load unpacked" fails, ensure you're selecting the folder that contains manifest.json.
- If the icon doesn't appear, confirm the extension is enabled and pinned.
- If changes don't appear, try full reload of the page plus reloading the extension.

## License & Contributing

- See project files for license information.
- Contributions: fork, create a branch, and submit a pull request.

If you need specific commands or the repository URL added, provide it and the README will be updated.