# PhilHealth EPRS Basic Salary Update Automation

A browser userscript that helps employers review and update active members’ monthly basic salaries in the PhilHealth Electronic Premium Reporting System (EPRS) using a CSV file.

> **Important:** Despite the panel’s “PhilHealth Contribution Uploader” title, this tool updates member basic salary records. It does not calculate, pay, or upload monthly premium contributions.

## For end users

See the [End-User Guide](docs/user-guide.md) for installation, CSV preparation, Dry Run, Live Update, stopping or resuming a run, and reviewing the exported results.

See the [Privacy Declaration](docs/privacy-declaration.md) for the data handling visible in the userscript code.

## Requirements

- Access to the PhilHealth EPRS employer portal.
- A browser with a compatible userscript manager installed and enabled, such as Tampermonkey.
- The userscript installed in that manager with its requested storage permissions enabled.
- A CSV containing a member-number column and a monthly basic salary column.

The script runs on these EPRS pages, as declared in its userscript metadata:

- `https://eprs01.philhealth.gov.ph/index.html`
- `https://eprs01.philhealth.gov.ph/header.asp`

## Installation

Install `src/philhealth-contribution-uploader.user.js` in your userscript manager. For a managed or organization-provided deployment, use the approved copy and installation instructions supplied by your administrator. The script requests the userscript manager storage grants `GM_getValue`, `GM_setValue`, and `GM_deleteValue` for run checkpoints.

## CSV format

The CSV must have a header row and at least one data row. Select the member-number and salary columns in the panel after choosing a file. The header names can vary; the default member-column selection recognizes `PHIC`, and the salary-column default chooses the first header other than `PHIC`, `NAME`, or `EMPCODE` when possible.

- Member numbers may contain 11 or 12 digits. An 11-digit value is normalized by adding a leading zero.
- Salary values must be greater than zero and may have up to two decimal places. Commas used as thousands separators are accepted.
- Duplicate normalized member numbers and invalid rows are marked and skipped.
- Every data row must have the same number of columns as the header.

## How it works

1. The panel reads the selected CSV, parses its header and rows, and lets the user map the member and salary fields.
2. **Dry Run** searches each usable member number in EPRS and checks for an exact matching active member profile. It does not submit salary changes.
3. **Live Update** asks for confirmation, enters the selected salary when needed, submits the portal form, then searches and reads the profile back to verify the result.
4. **Pause**, **Stop**, and **Resume Checkpoint** control or resume a saved run. Resuming requires reselecting the same CSV and matching column mapping; after a pause or stop, reload the portal if needed to load the saved checkpoint into the panel.
5. **Download CSV** exports the original input columns plus automation status, result details, timestamps, retry information, and run ID.

Checkpoints are stored through the userscript manager. The checkpoint includes run metadata and hashed member numbers, rather than raw member numbers. The selected CSV and downloaded result file may still contain personal information and should be handled according to the employer’s data-handling practices.

## Technical notes

- **Entry point:** `src/philhealth-contribution-uploader.user.js` is the complete userscript file. Its `// source:` comments identify logical modules that are bundled into this file; the referenced individual module files are not present in this repository.
- **Structure:** The bundled modules cover CSV parsing, validation, run state, checkpoint storage, EPRS DOM inspection and actions, the controller, panel UI, result export, and startup.
- **Portal integration:** Startup locates the EPRS frames and mounts the panel in the containing document. The automation depends on the portal pages, frames, forms, and selectors remaining compatible.
- **Development:** This repository has no package manifest, build command, or automated test suite. A syntax check can be run with `node --check src/philhealth-contribution-uploader.user.js`. Exercise Dry Run and Live Update only in an authorized EPRS environment.
- **No deployment build:** Edit or distribute the userscript file itself. There is no separate source-to-bundle command in this repository.

## Limitations

- The script only matches the EPRS URLs listed above and expects the portal’s main and header frames.
- A portal layout or selector change may stop a run. Review the downloaded results and portal state before attempting to resume.
- Dry Run is a review aid, not a guarantee that the portal will accept a later update. Confirm the intended CSV, mapping, and target values before choosing Live Update.

## License

See [LICENSE](LICENSE).
