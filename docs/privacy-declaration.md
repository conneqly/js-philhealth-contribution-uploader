# Privacy Declaration

This declaration describes the data handling visible in the PhilHealth EPRS salary-update userscript source. It is a technical description of this project, not a formal privacy policy for an employer, userscript manager, browser vendor, or PhilHealth.

## Passwords and login credentials

**This userscript does not collect, store, or save your EPRS password or other login credentials.** It only detects that a password field is present to recognize the portal’s login page; it does not read or inspect the password field’s contents. This statement applies to the userscript itself, not password handling by your browser or userscript manager.

## Information handled by the userscript

When you choose a CSV file, the userscript reads its contents in the browser. The file can include any columns you provide, including member numbers, names, employee codes, and salary values. The script keeps the parsed rows in page memory while the page is open so it can process the run and create a results file.

The script also calculates a SHA-256 fingerprint of the CSV contents and SHA-256 hashes of member numbers to associate a later run with its checkpoint. These hashes are not encryption and should not be treated as anonymous data; someone with the original values may be able to compare them.

## Information sent to PhilHealth EPRS

The script interacts with EPRS using the portal’s existing search and salary-update forms:

- During a Dry Run, it enters member numbers into EPRS searches and reads matching member profile information, including active status and current salary. It does not submit salary changes in this mode.
- During a Live Update, it may enter the desired salary into the EPRS form and submit it, then search and read the profile again to verify the result.

These actions send information to the EPRS portal as part of its normal operation. Do not use the script with an account or data you are not authorized to access.

## Checkpoints and browser storage

Run checkpoints are saved through the userscript manager’s storage functions. A checkpoint contains run and row status, selected column mapping, a CSV fingerprint, timestamps and counts, and member-number hashes. The checkpoint schema does not store the raw member numbers or original CSV rows.

Checkpoint data may remain in the userscript manager’s storage between page visits until the script clears or replaces it, or it is removed through the manager. Storage location, backup, or synchronization behavior may depend on the userscript manager and its settings; consult that product’s privacy information for those details.

## Results files

When you choose **Download CSV**, the script creates a results file in the browser from the original CSV rows and run results. It includes the original columns and added status and audit fields, so it can contain personal and salary information. The file is downloaded to the location configured by your browser. The script does not upload this generated file to a project-operated service.

## Network activity and third parties

The reviewed userscript source contains no direct calls to analytics services or to a developer-operated API. Its portal lookups and updates use normal browser form submissions and navigation to EPRS. This statement describes the userscript code; it does not describe data practices of PhilHealth, your browser, your userscript manager, or other browser extensions.

## Your responsibilities

- Use only CSV data you are authorized to process.
- Review the file and column selections before starting a run, and carefully review the confirmation before Live Update.
- Protect downloaded CSVs and avoid sharing them through public or unapproved channels.
- Review the privacy and synchronization settings of your browser and userscript manager.

For organization-specific questions about legal basis, data-subject rights, retention requirements, or a privacy contact, consult your employer’s privacy notice or privacy officer. This project does not provide those organization-specific details.
