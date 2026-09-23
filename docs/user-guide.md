# PhilHealth EPRS Salary Update — User Guide

This guide is for people who use the uploader panel but do not need to know how it is programmed.

> **Please read first:** The panel is titled “PhilHealth Contribution Uploader,” but it updates members’ **monthly basic salary** records in EPRS. It does not calculate or pay PhilHealth contributions.

## What you need

- Access to your employer’s PhilHealth EPRS portal.
- Tampermonkey installed and enabled in the same browser you use for EPRS.
- A CSV file with one column containing PhilHealth Identification Numbers (PHIC/member numbers) and another containing the monthly basic salary values you want to use.

## Install Tampermonkey and the userscript

1. In the browser you use for EPRS, go to the [official Tampermonkey website](https://www.tampermonkey.net/).
2. Choose your browser on the Tampermonkey website, open its official extension-store listing, and install the extension. Approve the browser’s **Add extension** or equivalent prompt. If Tampermonkey is already installed, make sure it is enabled.
3. After the userscript is published on GitHub’s `main` branch, open this [GitHub Raw userscript link](https://raw.githubusercontent.com/conneqly/js-philhealth-contribution-uploader/main/src/philhealth-contribution-uploader.user.js) in the same browser.
4. Tampermonkey should show an installation page for **PhilHealth EPRS Basic Salary Update Automation**. Review the script name and requested permissions, then choose **Install**.
5. Open Tampermonkey’s dashboard or installed scripts list and confirm that the script is enabled.
6. Open or refresh the employer EPRS portal and sign in. The uploader panel should appear on the supported EPRS page.

**Availability note:** The GitHub Raw link will return an error until the script file has been published at that path on the `main` branch. If the repository is private or the link is unavailable, ask your administrator for an approved script file or accessible installation link. Only install userscripts from a source you trust.

If the panel does not appear after installation, check that Tampermonkey and the script are enabled, then confirm you are on the employer EPRS portal. Ask your administrator for help if it still does not appear.

## Prepare your CSV

1. Save your spreadsheet as a **CSV** file.
2. Include a header row naming each column, followed by one member per row.
3. Keep the member number and salary in separate columns. Other columns, such as employee name or code, can stay in the file.
4. Check that every row has the same number of columns as the header and remove accidental duplicate member numbers.

Member numbers should contain 11 or 12 digits. The tool adds a leading zero to an 11-digit number. Salary values must be greater than zero and can have up to two decimal places (for example, `12500` or `12500.50`). Commas as thousands separators are accepted (for example, `12,500.50`).

## Run a Dry Run first

1. Open the EPRS employer portal and sign in.
2. In the panel, choose your CSV file.
3. Check the **Member column** and **Salary column** selections. Choose the correct columns if the automatic selections are not right.
4. Select **Dry Run**.
5. Let the run finish. Dry Run looks up members and checks whether there is exactly one matching, active member profile. It does **not** submit salary changes.
6. Select **Download CSV** to save the results. Review the status and message for each row before deciding what to do next.

Rows with invalid values, duplicate numbers, no exact match, ambiguous matches, or members who are not active are not eligible for an update. Correct your CSV or ask your EPRS administrator about rows you cannot resolve.

## Make live salary updates

**Live Update changes salary records in EPRS.** Only continue after reviewing the Dry Run results and confirming that the selected file and columns are correct.

1. Keep the same CSV selected and keep the same column mappings used for the Dry Run if you want to rely on its eligibility results.
2. Select **Live Update**.
3. Read the confirmation prompt and continue only if the number of rows is what you expect.
4. Keep the portal open while the run works. The panel shows the current status and progress.
5. When it finishes, use **Download CSV** and review the results. A row marked as verified means the tool read the salary back from the portal after submission.

If you change the CSV or its column mapping after the Dry Run, the tool may use a different set of rows. Always read the confirmation prompt and review the resulting CSV.

## Pause, stop, or resume

- **Pause** temporarily pauses an active run. Use **Resume Checkpoint** to continue later.
- **Stop** halts the current run. If a matching checkpoint is available, you can use **Resume Checkpoint** to continue.
- If **Resume Checkpoint** is not available after pausing or stopping, refresh the EPRS page, choose the same CSV file, and keep the same member and salary column selections. The saved checkpoint is tied to that file’s contents and mapping, so re-saving or editing the CSV may prevent resuming the earlier run.
- If EPRS signs you out or the portal stops responding, sign in again and review the panel before resuming. If the portal state is unclear, do not start another Live Update until you have checked the downloaded results and the member records.

## Downloaded results

The results CSV keeps your original columns and adds information such as the selected salary column, desired salary, automation status, result message, timestamps, retry count, and run ID. Keep this file secure: it may contain member numbers and salary information.

Common result messages include:

- **Eligible active member verified** — Dry Run found one matching active member.
- **Salary update verified by read-back** — Live Update submitted a change and confirmed the new salary in EPRS.
- **Salary already matches** — no update was needed.
- **Member is not Active; no change made** — the profile is not active, so the tool did not change it.
- **Invalid member number / Invalid salary value** — correct the corresponding CSV value.
- **No exact member match / Multiple matching results** — check the member number and ask your EPRS administrator if needed.
- **Update outcome could not be verified / Unexpected portal response** — stop and check the portal and results before trying again.

## Protect member information

Only use CSV files you are authorized to process. Do not share the source or results CSV in public channels. Run the tool only in your employer’s authorized EPRS account, and confirm salary values before approving Live Update.

For details about the CSV data, portal submissions, checkpoints, and downloaded results, see the [Privacy Declaration](privacy-declaration.md).
