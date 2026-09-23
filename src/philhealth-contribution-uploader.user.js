// ==UserScript==
// @name         PhilHealth EPRS Basic Salary Update Automation
// @namespace    local.philhealth.eprs
// @author       macoymejia.com
// @version      0.5.0
// @description  Dry-run, update, and verify active-member salary changes from CSV.
// @match        https://eprs01.philhealth.gov.ph/index.html
// @match        https://eprs01.philhealth.gov.ph/header.asp
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

// source: src/namespace.js
globalThis.PHICEPRS = globalThis.PHICEPRS || {};

// source: src/csv.js
(function installCsv(P) {
  "use strict";

  function parseRows(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    const input = String(text).replace(/^\uFEFF/, "");

    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      if (quoted) {
        if (char === '"' && input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else if (char === '"') {
          quoted = false;
        } else {
          field += char;
        }
      } else if (char === '"' && field === "") {
        quoted = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n" || char === "\r") {
        if (char === "\r" && input[index + 1] === "\n") index += 1;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += char;
      }
    }
    if (quoted) throw new Error("CSV contains an unclosed quoted field");
    if (field !== "" || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((cells) => cells.some((cell) => cell !== ""));
  }

  function normalizeHeader(header) {
    return String(header).replace(/^\uFEFF/, "").trim().toUpperCase();
  }

  function parse(text) {
    const matrix = parseRows(text);
    if (matrix.length < 2) throw new Error("CSV must contain a header and at least one row");
    const originalHeaders = matrix[0];
    const normalizedHeaders = originalHeaders.map(normalizeHeader);
    if (new Set(normalizedHeaders).size !== normalizedHeaders.length) {
      throw new Error("CSV contains duplicate normalized headers");
    }
    const rows = matrix.slice(1).map((cells) => {
      if (cells.length !== originalHeaders.length) throw new Error("CSV row has an unexpected column count");
      return Object.fromEntries(originalHeaders.map((header, index) => [header, cells[index]]));
    });
    return { originalHeaders, normalizedHeaders, rows };
  }

  function quote(value) {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function serialize(headers, rows) {
    return [headers.map(quote).join(","), ...rows.map((row) => headers.map((header) => quote(row[header])).join(","))].join("\r\n");
  }

  P.csv = { normalizeHeader, parse, serialize };
})(globalThis.PHICEPRS);

// source: src/validation.js
(function installValidation(P) {
  "use strict";

  function normalizeSalary(value) {
    const canonical = String(value).trim().replace(/,/g, "");
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(canonical)) return null;
    if (Number(canonical) <= 0 || canonical.length > 11) return null;
    return canonical;
  }

  function normalizeMemberNumber(value) {
    const text = String(value ?? "").trim();
    if (/^\d{12}$/.test(text)) return text;
    if (/^\d{11}$/.test(text)) return `0${text}`;
    return null;
  }

  function prepare(parsed, mapping) {
    if (!parsed.originalHeaders.includes(mapping.memberColumn) || !parsed.originalHeaders.includes(mapping.salaryColumn)) {
      return { rows: [], errors: ["INVALID_MAPPING"], mapping };
    }
    const seen = new Set();
    const errors = [];
    const rows = parsed.rows.map((raw, index) => {
      const memberNumber = normalizeMemberNumber(raw[mapping.memberColumn]);
      const desiredSalary = normalizeSalary(raw[mapping.salaryColumn]);
      let status = "READY";
      let message = "";
      if (!memberNumber) {
        status = "INVALID_PHIC";
        message = "Invalid member number";
        errors.push("INVALID_PHIC");
      } else if (!desiredSalary) {
        status = "INVALID_SALARY";
        message = "Invalid salary value";
        errors.push("INVALID_SALARY");
      } else if (seen.has(memberNumber)) {
        status = "DUPLICATE_MEMBER_NUMBER";
        message = "Duplicate member number";
        errors.push("DUPLICATE_MEMBER_NUMBER");
      }
      if (memberNumber) seen.add(memberNumber);
      return { rowNumber: index + 2, raw, memberNumber, desiredSalary, status, message };
    });
    const uniqueErrors = [...new Set(errors)];
    return { rows, errors: uniqueErrors, mapping };
  }

  P.validation = { normalizeMemberNumber, normalizeSalary, prepare };
})(globalThis.PHICEPRS);

// source: src/state.js
(function installState(P) {
  "use strict";

  const MODES = Object.freeze({ DRY: "DRY", UPDATE: "UPDATE" });
  const STATES = Object.freeze({
    IDLE: "IDLE", VALIDATING: "VALIDATING", DRY_LOOKUP: "DRY_LOOKUP",
    DRY_PROFILE_CHECK: "DRY_PROFILE_CHECK", DRY_COMPLETE: "DRY_COMPLETE",
    SUBMIT_LOOKUP: "SUBMIT_LOOKUP", SUBMIT_PROFILE_CHECK: "SUBMIT_PROFILE_CHECK",
    SUBMITTING: "SUBMITTING", VERIFYING: "VERIFYING", PAUSED_SESSION: "PAUSED_SESSION",
    PAUSED_USER: "PAUSED_USER", STOPPED_ERROR: "STOPPED_ERROR", COMPLETE: "COMPLETE",
  });

  const STATUS = Object.freeze({
    READY: "READY", DRY_OK: "DRY_OK", INVALID_PHIC: "INVALID_PHIC",
    INVALID_SALARY: "INVALID_SALARY", DUPLICATE_MEMBER_NUMBER: "DUPLICATE_MEMBER_NUMBER",
    NOT_FOUND: "NOT_FOUND",
    AMBIGUOUS_MATCH: "AMBIGUOUS_MATCH", STATUS_MISMATCH: "STATUS_MISMATCH",
    NO_CHANGE: "NO_CHANGE", SUBMIT_REJECTED: "SUBMIT_REJECTED", VERIFY_UNKNOWN: "VERIFY_UNKNOWN",
    UPDATED_VERIFIED: "UPDATED_VERIFIED", STOPPED_ERROR: "STOPPED_ERROR",
  });

  const table = Object.freeze({
    "IDLE:START_VALIDATION": STATES.VALIDATING,
    "VALIDATING:VALIDATION_PASSED": STATES.DRY_LOOKUP,
    "DRY_LOOKUP:LOOKUP_EXACT": STATES.DRY_PROFILE_CHECK,
    "DRY_PROFILE_CHECK:NEXT_ROW": STATES.DRY_LOOKUP,
    "DRY_PROFILE_CHECK:DRY_RUN_FINISHED": STATES.DRY_COMPLETE,
    "SUBMIT_LOOKUP:LOOKUP_EXACT": STATES.SUBMIT_PROFILE_CHECK,
    "SUBMIT_PROFILE_CHECK:SALARY_POPULATED": STATES.SUBMITTING,
    "SUBMITTING:SUBMIT_INITIATED": STATES.VERIFYING,
    "VERIFYING:VERIFIED_NEXT": STATES.SUBMIT_LOOKUP,
    "VERIFYING:VERIFIED_LAST": STATES.COMPLETE,
  });

  const ACTIVE_STATES = Object.freeze([
    STATES.DRY_LOOKUP, STATES.DRY_PROFILE_CHECK,
    STATES.SUBMIT_LOOKUP, STATES.SUBMIT_PROFILE_CHECK,
    STATES.SUBMITTING, STATES.VERIFYING,
  ]);

  function isActiveState(state) {
    return ACTIVE_STATES.includes(state);
  }

  function createRun({ rows, fileFingerprint, mapping, mode, candidateRowNumbers }) {
    return {
      state: STATES.IDLE,
      runId: crypto.randomUUID ? crypto.randomUUID() : `run-${Date.now()}`,
      fileFingerprint,
      mapping: { ...mapping },
      mode,
      rows: (rows || []).map((row) => ({ ...row })),
      currentRowIndex: 0,
      candidateRowNumbers: [...(candidateRowNumbers || [])],
      submittedCount: 0,
      resultMessage: "",
    };
  }

  function transition(run, event) {
    if (event.type === "PAUSE" || event.type === "SESSION_EXPIRED") {
      if (!isActiveState(run.state)) return run;
      return {
        ...run,
        pausedFrom: run.state,
        state: event.type === "PAUSE" ? STATES.PAUSED_USER : STATES.PAUSED_SESSION,
      };
    }
    const next = { ...run };
    const nextState = table[`${run.state}:${event.type}`];
    if (!nextState) return { ...next, state: STATES.STOPPED_ERROR, resultMessage: "Illegal state transition" };
    next.state = nextState;
    if (event.type === "DRY_RUN_FINISHED") next.candidateRowNumbers = [...(event.eligibleRowNumbers || [])];
    return next;
  }

  P.state = { MODES, STATES, STATUS, createRun, isActiveState, transition };
})(globalThis.PHICEPRS);

// source: src/storage.js
(function installStorage(P) {
  "use strict";

  const KEY = "phic-eprs-checkpoint-v1";
  const MAX_LOOKUP_RETRIES = 2;
  const PROCESSING_STAGES = Object.freeze(["LOOKUP", "LOOKUP_RETRY", "VERIFY_LOOKUP", "VERIFY_MATCH", "VERIFY_PROFILE"]);
  const STOP_REASONS = Object.freeze(["LOOKUP_FAILED", "UNEXPECTED_PAGE", "SELECTOR_MISMATCH", "AMBIGUOUS_MATCH", "VERIFY_UNKNOWN", "PORTAL_ERROR", "STOPPED_BY_USER"]);
  const RUN_KEYS = Object.freeze([
    "state", "runId", "fileFingerprint", "mapping", "mode", "currentRowIndex",
    "candidateRowNumbers", "pausedFrom", "submissionArmed", "submittedCount", "usesDryCandidates", "rows",
  ]);
  const REQUIRED_RUN_KEYS = Object.freeze([
    "state", "runId", "fileFingerprint", "mapping", "mode", "currentRowIndex",
    "candidateRowNumbers", "submissionArmed", "submittedCount", "usesDryCandidates", "rows",
  ]);
  const ROW_KEYS = Object.freeze([
    "rowNumber", "memberHash", "status", "dryRunAt", "submittedAt", "verifiedAt",
    "attemptCount", "lookupRetryCount", "processingStage", "stopReason",
  ]);
  const REQUIRED_ROW_KEYS = Object.freeze([
    "rowNumber", "memberHash", "status", "attemptCount", "lookupRetryCount",
    "processingStage", "stopReason",
  ]);
  const MAPPING_KEYS = Object.freeze(["memberColumn", "salaryColumn"]);
  const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const MEMBER_HASH_SHAPE = /^[0-9a-f]{64}$/;
  const ISO_TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const DRY_ROW_STATUSES = Object.freeze(["READY", "DRY_OK", "NOT_FOUND", "AMBIGUOUS_MATCH", "STATUS_MISMATCH", "PORTAL_ERROR", "INVALID_PHIC", "INVALID_SALARY", "DUPLICATE_MEMBER_NUMBER"]);
  const UPDATE_ROW_STATUSES = Object.freeze(["READY", "NOT_FOUND", "AMBIGUOUS_MATCH", "STATUS_MISMATCH", "NO_CHANGE", "VERIFY_UNKNOWN", "UPDATED_VERIFIED", "PORTAL_ERROR", "INVALID_PHIC", "INVALID_SALARY", "DUPLICATE_MEMBER_NUMBER"]);
  const SKIPPED_STATUSES = Object.freeze(["INVALID_PHIC", "INVALID_SALARY", "DUPLICATE_MEMBER_NUMBER"]);
  const DRY_FINAL_STATUSES = Object.freeze(["DRY_OK", "NOT_FOUND", "STATUS_MISMATCH"]);
  const UPDATE_FINAL_STATUSES = Object.freeze(["NOT_FOUND", "STATUS_MISMATCH", "NO_CHANGE", "UPDATED_VERIFIED"]);

  async function sha256(value) {
    const bytes = new TextEncoder().encode(String(value));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function sanitizeDiagnostics(value = {}) {
    const lookupRetryCount = value.lookupRetryCount;
    return {
      lookupRetryCount: Number.isInteger(lookupRetryCount) && lookupRetryCount >= 0 && lookupRetryCount <= MAX_LOOKUP_RETRIES ? lookupRetryCount : 0,
      processingStage: PROCESSING_STAGES.includes(value.processingStage) ? value.processingStage : "",
      stopReason: STOP_REASONS.includes(value.stopReason) ? value.stopReason : "",
    };
  }

  function invalidCheckpoint() {
    throw new Error("Checkpoint is invalid");
  }

  function assertDataRecord(value, allowedKeys, requiredKeys = []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalidCheckpoint();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalidCheckpoint();
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))) invalidCheckpoint();
    if (requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) invalidCheckpoint();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) invalidCheckpoint();
    }
  }

  function assertDenseDataArray(value) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalidCheckpoint();
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) invalidCheckpoint();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) invalidCheckpoint();
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) invalidCheckpoint();
    }
  }

  function validatedTimestamp(value) {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !ISO_TIMESTAMP_SHAPE.test(value)) invalidCheckpoint();
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) invalidCheckpoint();
    return value;
  }

  function assertIntegerInRange(value, minimum, maximum) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) invalidCheckpoint();
  }

  function arraysEqual(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  function activeStatesForMode(mode) {
    if (mode === P.state.MODES.DRY) return [P.state.STATES.DRY_LOOKUP, P.state.STATES.DRY_PROFILE_CHECK];
    return [
      P.state.STATES.SUBMIT_LOOKUP, P.state.STATES.SUBMIT_PROFILE_CHECK,
      P.state.STATES.SUBMITTING, P.state.STATES.VERIFYING,
    ];
  }

  function validateModeAndState(checkpoint) {
    if (![P.state.MODES.DRY, P.state.MODES.UPDATE].includes(checkpoint.mode)) invalidCheckpoint();
    const activeStates = activeStatesForMode(checkpoint.mode);
    const terminalStates = checkpoint.mode === P.state.MODES.DRY
      ? [P.state.STATES.DRY_COMPLETE, P.state.STATES.STOPPED_ERROR]
      : [P.state.STATES.COMPLETE, P.state.STATES.STOPPED_ERROR];
    const pausedStates = [P.state.STATES.PAUSED_SESSION, P.state.STATES.PAUSED_USER];
    if (![...activeStates, ...terminalStates, ...pausedStates].includes(checkpoint.state)) invalidCheckpoint();
    if (pausedStates.includes(checkpoint.state)) {
      if (!activeStates.includes(checkpoint.pausedFrom)) invalidCheckpoint();
    } else if (checkpoint.pausedFrom !== undefined) invalidCheckpoint();
    const effectiveState = pausedStates.includes(checkpoint.state) ? checkpoint.pausedFrom : checkpoint.state;
    if (typeof checkpoint.submissionArmed !== "boolean") invalidCheckpoint();
    if (checkpoint.submissionArmed
      && (checkpoint.mode !== P.state.MODES.UPDATE || effectiveState !== P.state.STATES.SUBMITTING)) invalidCheckpoint();
    return effectiveState;
  }

  function validateMapping(savedMapping, expectedMapping) {
    assertDataRecord(savedMapping, MAPPING_KEYS, MAPPING_KEYS);
    if (typeof savedMapping.memberColumn !== "string" || typeof savedMapping.salaryColumn !== "string") invalidCheckpoint();
    if (!expectedMapping || savedMapping.memberColumn !== expectedMapping.memberColumn
      || savedMapping.salaryColumn !== expectedMapping.salaryColumn) invalidCheckpoint();
    return { memberColumn: savedMapping.memberColumn, salaryColumn: savedMapping.salaryColumn };
  }

  function validateCandidateRows(mode, state, candidateRowNumbers, preparedRowNumbers) {
    assertDenseDataArray(candidateRowNumbers);
    const positions = new Map(preparedRowNumbers.map((rowNumber, index) => [rowNumber, index]));
    let previousPosition = -1;
    for (const rowNumber of candidateRowNumbers) {
      if (!Number.isInteger(rowNumber) || !positions.has(rowNumber)) invalidCheckpoint();
      const position = positions.get(rowNumber);
      if (position <= previousPosition) invalidCheckpoint();
      previousPosition = position;
    }
    if (mode === P.state.MODES.DRY && state !== P.state.STATES.DRY_COMPLETE
      && !arraysEqual(candidateRowNumbers, preparedRowNumbers)) invalidCheckpoint();
    if (mode === P.state.MODES.UPDATE && candidateRowNumbers.length === 0) invalidCheckpoint();
    return [...candidateRowNumbers];
  }

  function validateRowDiagnostics(savedRow) {
    const diagnostics = sanitizeDiagnostics(savedRow);
    if (savedRow.lookupRetryCount !== diagnostics.lookupRetryCount
      || savedRow.processingStage !== diagnostics.processingStage
      || savedRow.stopReason !== diagnostics.stopReason) invalidCheckpoint();
    return diagnostics;
  }

  function validateTimestampAndAttemptSemantics(mode, row, usesDryCandidates) {
    const hasDryTimestamp = row.dryRunAt !== undefined;
    const hasSubmittedTimestamp = row.submittedAt !== undefined;
    const hasVerifiedTimestamp = row.verifiedAt !== undefined;
    if (mode === P.state.MODES.DRY) {
      if (row.attemptCount !== 0 || hasSubmittedTimestamp || hasVerifiedTimestamp) invalidCheckpoint();
      if (DRY_FINAL_STATUSES.includes(row.status) !== hasDryTimestamp) invalidCheckpoint();
      return;
    }
    if (hasDryTimestamp && !usesDryCandidates) invalidCheckpoint();
    if ((row.attemptCount === 1) !== hasSubmittedTimestamp) invalidCheckpoint();
    if ((row.status === "UPDATED_VERIFIED") !== hasVerifiedTimestamp) invalidCheckpoint();
    if (["UPDATED_VERIFIED", "VERIFY_UNKNOWN"].includes(row.status) && row.attemptCount !== 1) invalidCheckpoint();
    if (!["READY", "UPDATED_VERIFIED", "VERIFY_UNKNOWN"].includes(row.status) && row.attemptCount !== 0) invalidCheckpoint();
    if (hasVerifiedTimestamp && row.submittedAt > row.verifiedAt) invalidCheckpoint();
  }

  function validateStopReasonSemantics(checkpoint, rows) {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row.stopReason) continue;
      if (checkpoint.state !== P.state.STATES.STOPPED_ERROR || index !== checkpoint.currentRowIndex) invalidCheckpoint();
      const expectedStatuses = {
        LOOKUP_FAILED: ["PORTAL_ERROR"],
        UNEXPECTED_PAGE: ["PORTAL_ERROR"],
        SELECTOR_MISMATCH: ["PORTAL_ERROR"],
        AMBIGUOUS_MATCH: ["AMBIGUOUS_MATCH"],
        VERIFY_UNKNOWN: ["VERIFY_UNKNOWN"],
        PORTAL_ERROR: ["PORTAL_ERROR"],
        STOPPED_BY_USER: ["READY"],
      };
      if (!expectedStatuses[row.stopReason]?.includes(row.status)) invalidCheckpoint();
    }
  }

  function validateProgressTopology(checkpoint, effectiveState, rows, candidates) {
    const currentIndex = checkpoint.currentRowIndex;
    const currentRowNumber = rows[currentIndex].rowNumber;
    const isSkipped = (status) => SKIPPED_STATUSES.includes(status);
    const isDryFinal = (status) => DRY_FINAL_STATUSES.includes(status) || isSkipped(status);
    if (checkpoint.mode === P.state.MODES.DRY) {
      if (checkpoint.state === P.state.STATES.DRY_COMPLETE) {
        if (currentIndex !== rows.length - 1 || !rows.every((row) => isDryFinal(row.status))) invalidCheckpoint();
        const eligibleRows = rows.filter((row) => row.status === "DRY_OK").map((row) => row.rowNumber);
        if (!arraysEqual(candidates, eligibleRows)) invalidCheckpoint();
        return;
      }
      for (let index = 0; index < rows.length; index += 1) {
        if (index < currentIndex && !isDryFinal(rows[index].status)) invalidCheckpoint();
        if (index > currentIndex && !(rows[index].status === "READY" || isSkipped(rows[index].status))) invalidCheckpoint();
      }
      const current = rows[currentIndex];
      if (checkpoint.state === P.state.STATES.STOPPED_ERROR) {
        if (!["READY", "AMBIGUOUS_MATCH", "PORTAL_ERROR"].includes(current.status)) invalidCheckpoint();
        if (current.status === "READY" ? current.stopReason !== "STOPPED_BY_USER" : !current.stopReason) invalidCheckpoint();
      } else if (current.status !== "READY") invalidCheckpoint();
      return;
    }

    const candidatePosition = candidates.indexOf(currentRowNumber);
    if (candidatePosition < 0) invalidCheckpoint();
    const candidateSet = new Set(candidates);
    const dryFinalSet = new Set(DRY_FINAL_STATUSES);
    for (const row of rows) {
      if (candidateSet.has(row.rowNumber)) continue;
      if (!(row.status === "READY" || (checkpoint.usesDryCandidates && dryFinalSet.has(row.status)) || isSkipped(row.status))) invalidCheckpoint();
    }
    if (checkpoint.state === P.state.STATES.COMPLETE) {
      if (candidatePosition !== candidates.length - 1
        || !candidates.every((rowNumber) => UPDATE_FINAL_STATUSES.includes(rows.find((row) => row.rowNumber === rowNumber).status))) invalidCheckpoint();
      return;
    }
    for (let position = 0; position < candidates.length; position += 1) {
      const row = rows.find((item) => item.rowNumber === candidates[position]);
      if (position < candidatePosition && !UPDATE_FINAL_STATUSES.includes(row.status)) invalidCheckpoint();
      if (position > candidatePosition && row.status !== "READY") invalidCheckpoint();
    }
    const current = rows[currentIndex];
    if (checkpoint.state === P.state.STATES.STOPPED_ERROR) {
      if (!["READY", "AMBIGUOUS_MATCH", "PORTAL_ERROR", "VERIFY_UNKNOWN"].includes(current.status)) invalidCheckpoint();
      if (current.status === "READY" ? current.stopReason !== "STOPPED_BY_USER" : !current.stopReason) invalidCheckpoint();
    } else if (current.status !== "READY") invalidCheckpoint();
    if ([P.state.STATES.SUBMIT_LOOKUP, P.state.STATES.SUBMIT_PROFILE_CHECK].includes(effectiveState)
      && current.attemptCount !== 0) invalidCheckpoint();
    if ([P.state.STATES.SUBMITTING, P.state.STATES.VERIFYING].includes(effectiveState)
      && current.attemptCount !== 1) invalidCheckpoint();
  }

  async function validateCheckpoint(prepared, fileFingerprint, expectedMapping, checkpoint) {
    assertDataRecord(checkpoint, RUN_KEYS, REQUIRED_RUN_KEYS);
    if (typeof checkpoint.runId !== "string" || !UUID_SHAPE.test(checkpoint.runId)) invalidCheckpoint();
    if (typeof checkpoint.fileFingerprint !== "string" || checkpoint.fileFingerprint !== fileFingerprint) invalidCheckpoint();
    const mapping = validateMapping(checkpoint.mapping, expectedMapping);
    const effectiveState = validateModeAndState(checkpoint);
    if (typeof checkpoint.usesDryCandidates !== "boolean") invalidCheckpoint();
    if (checkpoint.usesDryCandidates && checkpoint.mode !== P.state.MODES.UPDATE) invalidCheckpoint();
    assertDenseDataArray(checkpoint.rows);
    if (!prepared || !Array.isArray(prepared.rows) || prepared.rows.length === 0
      || checkpoint.rows.length !== prepared.rows.length) invalidCheckpoint();
    assertIntegerInRange(checkpoint.currentRowIndex, 0, prepared.rows.length - 1);

    const preparedRowNumbers = prepared.rows.map((row) => row.rowNumber);
    if (preparedRowNumbers.some((rowNumber, index) => !Number.isInteger(rowNumber)
      || (index > 0 && rowNumber <= preparedRowNumbers[index - 1]))) invalidCheckpoint();
    const candidates = validateCandidateRows(
      checkpoint.mode,
      checkpoint.state,
      checkpoint.candidateRowNumbers,
      preparedRowNumbers,
    );

    const rows = [];
    for (let index = 0; index < prepared.rows.length; index += 1) {
      const preparedRow = prepared.rows[index];
      const savedRow = checkpoint.rows[index];
      assertDataRecord(savedRow, ROW_KEYS, REQUIRED_ROW_KEYS);
      if (savedRow.rowNumber !== preparedRow.rowNumber) invalidCheckpoint();
      const memberHash = await sha256(preparedRow.memberNumber);
      if (!MEMBER_HASH_SHAPE.test(savedRow.memberHash) || savedRow.memberHash !== memberHash) invalidCheckpoint();
      const allowedStatuses = checkpoint.mode === P.state.MODES.DRY ? DRY_ROW_STATUSES : UPDATE_ROW_STATUSES;
      if (!allowedStatuses.includes(savedRow.status)) invalidCheckpoint();
      assertIntegerInRange(savedRow.attemptCount, 0, 1);
      const diagnostics = validateRowDiagnostics(savedRow);
      const row = {
        ...preparedRow,
        memberHash,
        status: savedRow.status,
        dryRunAt: validatedTimestamp(savedRow.dryRunAt),
        submittedAt: validatedTimestamp(savedRow.submittedAt),
        verifiedAt: validatedTimestamp(savedRow.verifiedAt),
        attemptCount: savedRow.attemptCount,
        lookupRetryCount: diagnostics.lookupRetryCount,
        processingStage: diagnostics.processingStage,
        stopReason: diagnostics.stopReason,
      };
      validateTimestampAndAttemptSemantics(checkpoint.mode, row, checkpoint.usesDryCandidates);
      rows.push(row);
    }

    assertIntegerInRange(checkpoint.submittedCount, 0, candidates.length);
    if (checkpoint.submittedCount !== rows.filter((row) => row.status === "UPDATED_VERIFIED").length) invalidCheckpoint();
    validateStopReasonSemantics(checkpoint, rows);
    validateProgressTopology(checkpoint, effectiveState, rows, candidates);

    return {
      state: checkpoint.state,
      runId: checkpoint.runId,
      fileFingerprint: checkpoint.fileFingerprint,
      mapping,
      mode: checkpoint.mode,
      currentRowIndex: checkpoint.currentRowIndex,
      candidateRowNumbers: candidates,
      pausedFrom: checkpoint.pausedFrom,
      submissionArmed: checkpoint.submissionArmed,
      usesDryCandidates: checkpoint.usesDryCandidates,
      submittedCount: checkpoint.submittedCount,
      rows,
    };
  }

  function safeCheckpoint(run) {
    return {
      state: run.state,
      runId: run.runId,
      fileFingerprint: run.fileFingerprint,
      mapping: run.mapping ? { ...run.mapping } : undefined,
      mode: run.mode,
      currentRowIndex: run.currentRowIndex ?? 0,
      candidateRowNumbers: [...(run.candidateRowNumbers || [])],
      pausedFrom: run.pausedFrom,
      submissionArmed: Boolean(run.submissionArmed),
      usesDryCandidates: Boolean(run.usesDryCandidates),
      submittedCount: run.submittedCount ?? 0,
      rows: (run.rows || []).map((row) => ({
        rowNumber: row.rowNumber,
        memberHash: row.memberHash,
        status: row.status,
        dryRunAt: row.dryRunAt,
        submittedAt: row.submittedAt,
        verifiedAt: row.verifiedAt,
        attemptCount: row.attemptCount ?? 0,
        ...sanitizeDiagnostics(row),
      })),
    };
  }

  function createStore(adapter = {}) {
    const get = adapter.get || ((key, fallback) => GM_getValue(key, fallback));
    const set = adapter.set || ((key, value) => GM_setValue(key, value));
    const remove = adapter.remove || ((key) => GM_deleteValue(key));
    return {
      saveCheckpoint: (run) => Promise.resolve(set(KEY, safeCheckpoint(run))),
      loadCheckpoint: () => Promise.resolve(get(KEY, null)),
      clearCheckpoint: () => Promise.resolve(remove(KEY)),
    };
  }

  P.storage = { KEY, createStore, safeCheckpoint, sanitizeDiagnostics, sha256, validateCheckpoint };
})(globalThis.PHICEPRS);

// source: src/eprs-dom.js
(function installEprsDom(P) {
  "use strict";

  const GRID_HEADERS = ["PIN", "Last Name", "Status", "Monthly Basic Salary"];
  const HEADER_CELL_INDEXES = [2, 3, 8, 9];

  function isGridHeader(row) {
    return row.cells.length === 10 && GRID_HEADERS.every((header, index) => (
      row.cells[HEADER_CELL_INDEXES[index]].textContent.replace(/\s+/g, " ").trim() === header
    ));
  }

  function pathOf(doc) {
    return new URL(doc.baseURI || doc.location.href).pathname;
  }

  function actionPath(form) {
    return new URL(form.action, form.ownerDocument.baseURI).pathname;
  }

  function findResultTable(doc) {
    return [...doc.querySelectorAll("table")].find((table) => [...table.rows].some(isGridHeader)) || null;
  }

  function getPinSearch(doc) {
    const form = doc.forms.namedItem("InputForm");
    const field = doc.querySelector('input[name="mempin"]');
    const submit = doc.querySelector('input[type="image"][name="submit2"][alt="Search PIN"]');
    if (!form || !field || !submit || actionPath(form) !== "/ee_list_pin.asp") {
      return { kind: "SELECTOR_MISMATCH" };
    }
    return { kind: "PIN_SEARCH", form, field, submit };
  }

  function isMemberRow(row) {
    return row.querySelectorAll('a[href^="ee_profile.asp?"]').length === 1 || row.cells.length === 10;
  }

  function exactProfileMatch(doc, requested) {
    const table = findResultTable(doc);
    if (!table) return { kind: "SELECTOR_MISMATCH" };
    const rows = [...table.rows];
    const memberRows = rows.filter((row) => !isGridHeader(row) && isMemberRow(row));
    for (const row of memberRows) {
      if (row.cells.length !== 10 || row.querySelectorAll('a[href^="ee_profile.asp?"]').length !== 1) {
        return { kind: "SELECTOR_MISMATCH" };
      }
    }
    const matches = memberRows.filter((row) => row.cells[2].textContent.replace(/\D/g, "") === requested);
    if (matches.length === 0) return { kind: "NOT_FOUND" };
    if (matches.length !== 1) return { kind: "AMBIGUOUS_MATCH" };
    return { kind: "EXACT", link: matches[0].querySelector('a[href^="ee_profile.asp?"]') };
  }

  function readProfile(doc) {
    const statusControl = doc.querySelector('select#internet[name="internet"]');
    if (!statusControl) return { kind: "SELECTOR_MISMATCH" };
    const status = statusControl.value;
    if (status !== "A") return { kind: "STATUS_MISMATCH", status };
    const form = doc.forms.namedItem("InputForm");
    const field = form?.querySelector('input#salary[name="salary"]');
    const submit = form?.querySelector('input[type="submit"][name="Submit"]');
    if (!form || actionPath(form) !== "/set_active.asp" || !field || field.disabled || !submit || submit.form !== form) {
      return { kind: "SELECTOR_MISMATCH" };
    }
    return { kind: "ACTIVE_PROFILE", status, salary: P.validation.normalizeSalary(field.value), statusControl, form, field, submit };
  }

  function classify(doc) {
    const path = pathOf(doc);
    if (path === "/default.asp" || doc.querySelector('input[type="password"]')) return "LOGIN";
    if (path === "/ee_profile.asp" || doc.querySelector('select#internet[name="internet"]')) return "PROFILE";
    const search = getPinSearch(doc);
    if (search.kind === "PIN_SEARCH") {
      if (path === "/ee_list_pin.asp" || path === "/ee_name.asp") return "SEARCH_RESULTS";
      return "LIST";
    }
    return "UNKNOWN";
  }

  P.eprs = { actionPath, classify, exactProfileMatch, findResultTable, getPinSearch, pathOf, readProfile };
})(globalThis.PHICEPRS);

// source: src/eprs-actions.js
(function installEprsActions(P) {
  "use strict";

  const forbidden = /(?:set_ne\.asp|set_separated\.asp|ee_unassign_grp\.asp|fileupload|posting|payment)/i;

  function isForbiddenAction(urlOrHandler) {
    return forbidden.test(String(urlOrHandler || ""));
  }

  function checkedPath(form, allowed) {
    const url = new URL(form.action, form.ownerDocument.baseURI);
    const origin = new URL(form.ownerDocument.baseURI).origin;
    if (url.origin !== origin || url.pathname !== allowed || isForbiddenAction(url.pathname)) {
      throw new Error("Verified EPRS action is no longer available");
    }
    return url.pathname;
  }

  function lookup(search, memberNumber) {
    if (search.kind !== "PIN_SEARCH" || !/^\d{12}$/.test(memberNumber)) throw new Error("PIN lookup is not valid");
    checkedPath(search.form, "/ee_list_pin.asp");
    if (search.field.form !== search.form || search.submit.form !== search.form) throw new Error("PIN controls changed form ownership");
    search.field.value = memberNumber;
    search.form.requestSubmit(search.submit);
  }

  function openProfile(match) {
    if (match.kind !== "EXACT" || !match.link) throw new Error("Exact profile match is required");
    const base = new URL(match.link.ownerDocument.baseURI);
    const target = new URL(match.link.href, base);
    if (target.origin !== base.origin || target.pathname !== "/ee_profile.asp") throw new Error("Profile destination is not allowed");
    match.link.click();
  }

  function populateSalary(profile, desiredSalary) {
    if (profile.kind !== "ACTIVE_PROFILE" || profile.statusControl.value !== "A") throw new Error("Active profile is required");
    checkedPath(profile.form, "/set_active.asp");
    if (profile.field.form !== profile.form) throw new Error("Salary field changed form ownership");
    const canonical = P.validation.normalizeSalary(desiredSalary);
    if (!canonical) throw new Error("Salary is invalid");
    const previous = profile.field.value;
    try {
      profile.field.value = canonical;
      const EventType = profile.field.ownerDocument.defaultView?.Event || Event;
      profile.field.dispatchEvent(new EventType("input", { bubbles: true }));
      profile.field.dispatchEvent(new EventType("change", { bubbles: true }));
      if (P.validation.normalizeSalary(profile.field.value) !== canonical) throw new Error("Salary field did not retain the target value");
      return { previous, value: canonical };
    } catch (error) {
      profile.field.value = previous;
      throw error;
    }
  }

  function submitSalary(profile) {
    checkedPath(profile.form, "/set_active.asp");
    if (profile.kind !== "ACTIVE_PROFILE" || profile.statusControl.value !== "A") throw new Error("Active profile is required");
    if (profile.submit.form !== profile.form || profile.field.form !== profile.form) throw new Error("Salary controls changed form ownership");
    profile.form.requestSubmit(profile.submit);
  }

  P.actions = { isForbiddenAction, lookup, openProfile, populateSalary, submitSalary };
})(globalThis.PHICEPRS);

// source: src/controller.js
(function installController(P) {
  "use strict";

  function create({ frame, stateStore, clock, ui, eprs, actions }) {
    const MAX_LOOKUP_RETRIES = 2;
    let run = null;
    let rawRows = null;
    let busy = false;
    let operationGeneration = 0;
    const time = clock || { delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: () => new Date().toISOString() };

    async function persist(next = run) {
      run = next;
      await stateStore.saveCheckpoint(run);
      ui.render(run);
    }

    function navigateList() {
      frame.contentWindow.location.assign("/ee_list.asp");
    }

    function currentRow() {
      return run.rows[run.currentRowIndex];
    }

    function nextReadyRowIndex(fromIndex) {
      for (let index = fromIndex; index < run.rows.length; index += 1) {
        if (run.rows[index].status === "READY") return index;
      }
      return -1;
    }

    function invalidateOperation() {
      operationGeneration += 1;
    }

    function retryContextIsCurrent(context) {
      const row = run?.rows?.[run.currentRowIndex];
      return operationGeneration === context.generation
        && run === context.run
        && run?.runId === context.runId
        && run?.mode === context.mode
        && run?.state === context.state
        && row?.rowNumber === context.rowNumber;
    }

    async function materializeRows(prepared) {
      rawRows = prepared.rows.map((row) => row.raw);
      const rows = [];
      for (const row of prepared.rows) {
        rows.push({
          ...row,
          memberHash: await P.storage.sha256(row.memberNumber),
          attemptCount: 0,
          lookupRetryCount: 0,
          processingStage: "LOOKUP",
          stopReason: "",
        });
      }
      return rows;
    }

    function mappingsMatch(left, right) {
      return Boolean(left && right
        && left.memberColumn === right.memberColumn
        && left.salaryColumn === right.salaryColumn);
    }

    async function previewSubmission(prepared, fileFingerprint, mapping) {
      const allRowNumbers = prepared.rows.filter((row) => row.status === "READY").map((row) => row.rowNumber);
      if (!run || run.mode !== P.state.MODES.DRY || run.state !== P.state.STATES.DRY_COMPLETE
        || run.fileFingerprint !== fileFingerprint || !mappingsMatch(run.mapping, mapping)
        || run.rows.length !== prepared.rows.length) return { rowNumbers: allRowNumbers, usesDryCandidates: false };
      for (let index = 0; index < prepared.rows.length; index += 1) {
        const preparedRow = prepared.rows[index];
        const dryRow = run.rows[index];
        if (dryRow?.rowNumber !== preparedRow.rowNumber || dryRow?.memberHash !== await P.storage.sha256(preparedRow.memberNumber)) {
          return { rowNumbers: allRowNumbers, usesDryCandidates: false };
        }
      }
      return {
        rowNumbers: run.rows.filter((row) => row.status === "DRY_OK").map((row) => row.rowNumber),
        usesDryCandidates: true,
      };
    }

    async function stopRun(reason) {
      run.state = P.state.STATES.STOPPED_ERROR;
      run.resultMessage = reason;
      await persist();
    }

    async function failCurrentRow(status, reason) {
      const row = currentRow();
      row.status = status;
      row.message = status;
      row.processingStage = "LOOKUP";
      row.stopReason = reason;
      await stopRun(reason);
    }

    async function failVerification() {
      const row = currentRow();
      row.status = "VERIFY_UNKNOWN";
      row.message = "VERIFY_UNKNOWN";
      row.processingStage = "VERIFY_LOOKUP";
      row.stopReason = "VERIFY_UNKNOWN";
      run.submissionArmed = false;
      await stopRun("VERIFY_UNKNOWN");
    }

    async function lookupBeforeSubmission(doc, row) {
      row.processingStage = "LOOKUP";
      try {
        actions.lookup(eprs.getPinSearch(doc), row.memberNumber);
        return;
      } catch (_) {
        const retries = row.lookupRetryCount || 0;
        if (retries >= MAX_LOOKUP_RETRIES) {
          row.status = "PORTAL_ERROR";
          row.stopReason = "LOOKUP_FAILED";
          row.processingStage = "LOOKUP";
          await stopRun("LOOKUP_FAILED");
          return;
        }
        row.lookupRetryCount = retries + 1;
        row.processingStage = "LOOKUP_RETRY";
        const retryContext = {
          generation: operationGeneration,
          run,
          runId: run.runId,
          mode: run.mode,
          state: run.state,
          rowNumber: row.rowNumber,
        };
        await persist();
        await time.delay(1500);
        if (!retryContextIsCurrent(retryContext)) return;
        navigateList();
      }
    }

    async function finishDryRow(status) {
      const row = currentRow();
      row.status = status;
      row.message = status;
      row.dryRunAt = time.now();
      if (run.state === P.state.STATES.DRY_LOOKUP) run.state = P.state.STATES.DRY_PROFILE_CHECK;
      const nextIndex = nextReadyRowIndex(run.currentRowIndex + 1);
      if (nextIndex >= 0) {
        run.currentRowIndex = nextIndex;
        run = P.state.transition(run, { type: "NEXT_ROW" });
        await persist();
        navigateList();
        return;
      }
      const eligibleRowNumbers = run.rows.filter((item) => item.status === "DRY_OK").map((item) => item.rowNumber);
      run.currentRowIndex = run.rows.length - 1;
      run = P.state.transition(run, { type: "DRY_RUN_FINISHED", eligibleRowNumbers });
      await persist();
    }

    async function advanceSubmission(status) {
      const row = currentRow();
      row.status = status;
      row.message = status;
      if (status === "UPDATED_VERIFIED") row.verifiedAt = time.now();
      run.submittedCount = (run.submittedCount || 0) + (status === "UPDATED_VERIFIED" ? 1 : 0);
      const candidates = run.candidateRowNumbers || [];
      const position = candidates.indexOf(row.rowNumber);
      const nextNumber = candidates[position + 1];
      if (!nextNumber) {
        run = P.state.transition({ ...run, state: P.state.STATES.VERIFYING }, { type: "VERIFIED_LAST" });
        await persist();
        return;
      }
      run.currentRowIndex = run.rows.findIndex((item) => item.rowNumber === nextNumber);
      run = P.state.transition({ ...run, state: P.state.STATES.VERIFYING }, { type: "VERIFIED_NEXT" });
      await persist();
      navigateList();
    }

    async function handleDry(page, doc) {
      const row = currentRow();
      if (run.state === P.state.STATES.DRY_LOOKUP) {
        if (page === "LIST") {
          await lookupBeforeSubmission(doc, row);
          return;
        }
        if (page === "SEARCH_RESULTS") {
          const match = eprs.exactProfileMatch(doc, row.memberNumber);
          if (match.kind === "NOT_FOUND") return finishDryRow("NOT_FOUND");
          if (match.kind === "AMBIGUOUS_MATCH") return failCurrentRow("AMBIGUOUS_MATCH", "AMBIGUOUS_MATCH");
          if (match.kind !== "EXACT") return failCurrentRow("PORTAL_ERROR", "SELECTOR_MISMATCH");
          run = P.state.transition(run, { type: "LOOKUP_EXACT" });
          await persist();
          actions.openProfile(match);
          return;
        }
        return failCurrentRow("PORTAL_ERROR", "UNEXPECTED_PAGE");
      }
      if (run.state === P.state.STATES.DRY_PROFILE_CHECK) {
        if (page !== "PROFILE") return failCurrentRow("PORTAL_ERROR", "UNEXPECTED_PAGE");
        const profile = eprs.readProfile(doc);
        if (profile.kind === "ACTIVE_PROFILE") return finishDryRow("DRY_OK");
        if (profile.kind === "STATUS_MISMATCH") return finishDryRow("STATUS_MISMATCH");
        return failCurrentRow("PORTAL_ERROR", "SELECTOR_MISMATCH");
      }
      return failCurrentRow("PORTAL_ERROR", "UNEXPECTED_PAGE");
    }

    async function handleSubmit(page, doc) {
      const row = currentRow();
      if (run.state === P.state.STATES.SUBMIT_LOOKUP) {
        if (page === "LIST") {
          await lookupBeforeSubmission(doc, row);
          return;
        }
        if (page === "SEARCH_RESULTS") {
          const match = eprs.exactProfileMatch(doc, row.memberNumber);
          if (match.kind === "NOT_FOUND") return advanceSubmission("NOT_FOUND");
          if (match.kind === "AMBIGUOUS_MATCH") return failCurrentRow("AMBIGUOUS_MATCH", "AMBIGUOUS_MATCH");
          if (match.kind !== "EXACT") return failCurrentRow("PORTAL_ERROR", "SELECTOR_MISMATCH");
          run = P.state.transition(run, { type: "LOOKUP_EXACT" });
          await persist();
          actions.openProfile(match);
          return;
        }
        return failCurrentRow("PORTAL_ERROR", "UNEXPECTED_PAGE");
      }
      if (run.state === P.state.STATES.SUBMIT_PROFILE_CHECK) {
        if (page !== "PROFILE") return failCurrentRow("PORTAL_ERROR", "UNEXPECTED_PAGE");
        const profile = eprs.readProfile(doc);
        if (profile.kind === "STATUS_MISMATCH") {
          run.state = P.state.STATES.VERIFYING;
          return advanceSubmission("STATUS_MISMATCH");
        }
        if (profile.kind !== "ACTIVE_PROFILE") return failCurrentRow("PORTAL_ERROR", "SELECTOR_MISMATCH");
        if (P.validation.normalizeSalary(profile.salary) === row.desiredSalary) return advanceSubmission("NO_CHANGE");
        actions.populateSalary(profile, row.desiredSalary);
        run = P.state.transition(run, { type: "SALARY_POPULATED" });
        row.submittedAt = time.now();
        row.attemptCount = (row.attemptCount || 0) + 1;
        run.submissionArmed = true;
        const submitContext = {
          generation: operationGeneration,
          run,
          runId: run.runId,
          mode: run.mode,
          state: run.state,
          rowNumber: row.rowNumber,
        };
        await persist();
        if (!retryContextIsCurrent(submitContext)) return;
        actions.submitSalary(profile);
        run = P.state.transition(run, { type: "SUBMIT_INITIATED" });
        run.submissionArmed = false;
        await persist();
        return;
      }
      return failCurrentRow("PORTAL_ERROR", "UNEXPECTED_PAGE");
    }

    async function handleVerification(page, doc) {
      const row = currentRow();
      if (page === "LIST") {
        row.processingStage = "VERIFY_MATCH";
        try {
          actions.lookup(eprs.getPinSearch(doc), row.memberNumber);
        } catch (_) {
          await failVerification();
        }
        return;
      }
      if (page === "SEARCH_RESULTS") {
        row.processingStage = "VERIFY_PROFILE";
        try {
          const match = eprs.exactProfileMatch(doc, row.memberNumber);
          if (match.kind !== "EXACT") return failVerification();
          actions.openProfile(match);
        } catch (_) {
          await failVerification();
        }
        return;
      }
      if (page === "PROFILE") {
        if (row.processingStage !== "VERIFY_PROFILE") {
          row.processingStage = "VERIFY_LOOKUP";
          await persist();
          navigateList();
          return;
        }
        try {
          const profile = eprs.readProfile(doc);
          if (profile.kind !== "ACTIVE_PROFILE") return failVerification();
          if (P.validation.normalizeSalary(profile.salary) !== row.desiredSalary) return failVerification();
          return advanceSubmission("UPDATED_VERIFIED");
        } catch (_) {
          await failVerification();
        }
        return;
      }
      return failVerification();
    }

    async function onFrameLoad() {
      if (!run || busy || [P.state.STATES.COMPLETE, P.state.STATES.STOPPED_ERROR, P.state.STATES.PAUSED_SESSION, P.state.STATES.PAUSED_USER, P.state.STATES.DRY_COMPLETE].includes(run.state)) return;
      const loadGeneration = operationGeneration;
      const loadContext = {
        generation: loadGeneration,
        run,
        runId: run.runId,
        mode: run.mode,
        state: run.state,
        rowNumber: run?.rows?.[run.currentRowIndex]?.rowNumber,
      };
      busy = true;
      try {
        const doc = frame.contentDocument;
        const page = eprs.classify(doc);
        if (page === "LOGIN") {
          run = P.state.transition(run, { type: "SESSION_EXPIRED" });
          if (run.state !== P.state.STATES.PAUSED_SESSION) return;
          await persist();
          return;
        }
        await time.delay(0);
        if (!retryContextIsCurrent(loadContext)) return;
        if ([P.state.STATES.DRY_LOOKUP, P.state.STATES.DRY_PROFILE_CHECK].includes(run.state)) await handleDry(page, doc);
        else if ([P.state.STATES.SUBMIT_LOOKUP, P.state.STATES.SUBMIT_PROFILE_CHECK].includes(run.state)) await handleSubmit(page, doc);
        else if ([P.state.STATES.SUBMITTING, P.state.STATES.VERIFYING].includes(run.state)) {
          if (run.state === P.state.STATES.SUBMITTING && run.submissionArmed) run.state = P.state.STATES.VERIFYING;
          await handleVerification(page, doc);
        }
      } catch (_) {
        if (operationGeneration !== loadGeneration || run?.runId !== loadContext.runId) return;
        const row = currentRow();
        if ([P.state.STATES.SUBMITTING, P.state.STATES.VERIFYING].includes(run.state)) await failVerification();
        else if (row) {
          row.status = "PORTAL_ERROR";
          row.message = "PORTAL_ERROR";
          row.processingStage = row.processingStage || "LOOKUP";
          row.stopReason = "PORTAL_ERROR";
          await stopRun("PORTAL_ERROR");
        } else await stopRun("PORTAL_ERROR");
      } finally {
        if (operationGeneration === loadGeneration) busy = false;
      }
    }

    async function startDryRun(prepared, fileFingerprint, mapping) {
      invalidateOperation();
      const rows = await materializeRows(prepared);
      run = P.state.createRun({ rows, fileFingerprint, mapping, mode: P.state.MODES.DRY, candidateRowNumbers: rows.map((row) => row.rowNumber) });
      run.currentRowIndex = rows.findIndex((row) => row.status === "READY");
      run = P.state.transition(run, { type: "START_VALIDATION" });
      run = P.state.transition(run, { type: "VALIDATION_PASSED" });
      await persist();
      busy = false;
      if (run.currentRowIndex < 0) {
        const eligibleRowNumbers = [];
        run.currentRowIndex = run.rows.length - 1;
        run = P.state.transition(run, { type: "DRY_RUN_FINISHED", eligibleRowNumbers });
        await persist();
        return;
      }
      navigateList();
    }

    async function startSubmission(prepared, fileFingerprint, mapping) {
      invalidateOperation();
      const plan = await previewSubmission(prepared, fileFingerprint, mapping);
      if (!plan.rowNumbers.length) throw new Error("No eligible rows are available");
      const rows = await materializeRows(prepared);
      if (plan.usesDryCandidates && run) {
        const candidateSet = new Set(plan.rowNumbers);
        for (const row of rows) {
          const dryRow = run.rows.find((item) => item.rowNumber === row.rowNumber);
          if (!dryRow) continue;
          if (dryRow.dryRunAt) row.dryRunAt = dryRow.dryRunAt;
          if (!candidateSet.has(row.rowNumber)) {
            row.status = dryRow.status;
            row.message = dryRow.status;
            row.processingStage = dryRow.processingStage;
            row.stopReason = dryRow.stopReason;
          }
        }
      }
      run = P.state.createRun({ rows, fileFingerprint, mapping, mode: P.state.MODES.UPDATE, candidateRowNumbers: plan.rowNumbers });
      run.usesDryCandidates = Boolean(plan.usesDryCandidates);
      run.currentRowIndex = run.rows.findIndex((row) => row.rowNumber === plan.rowNumbers[0]);
      run.state = P.state.STATES.SUBMIT_LOOKUP;
      await persist();
      busy = false;
      navigateList();
    }

    async function previewResume(prepared, fileFingerprint, mapping, checkpoint) {
      const validated = await P.storage.validateCheckpoint(prepared, fileFingerprint, mapping, checkpoint);
      const terminal = [P.state.STATES.DRY_COMPLETE, P.state.STATES.COMPLETE].includes(validated.state);
      const currentRowNumber = validated.rows[validated.currentRowIndex].rowNumber;
      const position = validated.candidateRowNumbers.indexOf(currentRowNumber);
      return {
        mode: validated.mode,
        totalCount: validated.rows.length,
        candidateCount: validated.candidateRowNumbers.length,
        remainingCount: terminal ? 0 : validated.candidateRowNumbers.length - Math.max(position, 0),
      };
    }

    async function resume(prepared, fileFingerprint, mapping, checkpoint) {
      if (run && run.rows.some((row) => (row.attemptCount || 0) >= 1)) {
        throw new Error("An active run with recorded submissions cannot be replaced");
      }
      const validated = await P.storage.validateCheckpoint(prepared, fileFingerprint, mapping, checkpoint);
      invalidateOperation();
      rawRows = prepared.rows.map((row) => row.raw);
      let resumedState = validated.state;
      const prior = validated.pausedFrom || validated.state;
      if ([P.state.STATES.DRY_LOOKUP, P.state.STATES.DRY_PROFILE_CHECK].includes(prior)) resumedState = P.state.STATES.DRY_LOOKUP;
      else if ([P.state.STATES.SUBMIT_LOOKUP, P.state.STATES.SUBMIT_PROFILE_CHECK].includes(prior)) resumedState = P.state.STATES.SUBMIT_LOOKUP;
      else if ([P.state.STATES.SUBMITTING, P.state.STATES.VERIFYING].includes(prior) || validated.submissionArmed) resumedState = P.state.STATES.VERIFYING;
      if (validated.state === P.state.STATES.STOPPED_ERROR) resumedState = P.state.STATES.STOPPED_ERROR;
      const currentStopReason = validated.rows[validated.currentRowIndex].stopReason;
      run = {
        state: resumedState,
        runId: validated.runId,
        fileFingerprint: validated.fileFingerprint,
        mapping: { ...validated.mapping },
        mode: validated.mode,
        rows: validated.rows,
        currentRowIndex: validated.currentRowIndex,
        candidateRowNumbers: [...validated.candidateRowNumbers],
        usesDryCandidates: validated.usesDryCandidates,
        submissionArmed: false,
        submittedCount: validated.submittedCount,
        resultMessage: resumedState === P.state.STATES.STOPPED_ERROR ? currentStopReason : "",
      };
      await persist();
      if ([P.state.STATES.DRY_LOOKUP, P.state.STATES.SUBMIT_LOOKUP, P.state.STATES.VERIFYING].includes(run.state)) {
        busy = false;
        navigateList();
      }
    }

    async function pause() {
      invalidateOperation();
      if (!run) return;
      const next = P.state.transition(run, { type: "PAUSE" });
      if (next === run) return;
      run = next;
      await persist();
    }

    async function stop() {
      invalidateOperation();
      if (!run) return;
      if ([P.state.STATES.COMPLETE, P.state.STATES.STOPPED_ERROR, P.state.STATES.DRY_COMPLETE].includes(run.state)) return;
      const row = currentRow();
      if (run.state === P.state.STATES.SUBMITTING || run.state === P.state.STATES.VERIFYING) {
        row.status = "VERIFY_UNKNOWN";
        row.message = "VERIFY_UNKNOWN";
        row.processingStage = "VERIFY_LOOKUP";
        row.stopReason = "VERIFY_UNKNOWN";
        run.submissionArmed = false;
        await stopRun("VERIFY_UNKNOWN");
        return;
      }
      row.stopReason = "STOPPED_BY_USER";
      await stopRun("STOPPED_BY_USER");
    }

    function abandon() {
      invalidateOperation();
      rawRows = null;
      busy = false;
      run = null;
    }

    frame.addEventListener("load", () => { void onFrameLoad(); });
    return { abandon, getRawRows: () => rawRows, getSnapshot: () => structuredClone(run), onFrameLoad, pause, previewResume, previewSubmission, resume, startDryRun, startSubmission, stop };
  }

  P.controller = { create };
})(globalThis.PHICEPRS);

// source: src/panel.js
(function installPanel(P) {
  "use strict";

  function element(doc, tag, text = "", attributes = {}) {
    const node = doc.createElement(tag);
    node.textContent = text;
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  }

  function maskMember(memberNumber) {
    const value = String(memberNumber || "");
    return value.length >= 4 ? `********${value.slice(-4)}` : "********";
  }

  function progressView(snapshot) {
    const rows = snapshot?.rows || [];
    const row = rows[snapshot?.currentRowIndex ?? 0];
    const candidates = snapshot?.candidateRowNumbers || [];
    const verified = snapshot?.submittedCount || 0;
    const modes = {
      DRY_LOOKUP: "DRY RUN",
      DRY_PROFILE_CHECK: "DRY RUN",
      DRY_COMPLETE: "DRY RUN COMPLETE",
      SUBMIT_LOOKUP: "UPDATING",
      SUBMIT_PROFILE_CHECK: "UPDATING",
      SUBMITTING: "UPDATING",
      VERIFYING: "VERIFYING",
      PAUSED_SESSION: "PAUSED",
      PAUSED_USER: "PAUSED",
      STOPPED_ERROR: "STOPPED",
      COMPLETE: "COMPLETE",
    };
    const submitting = ["SUBMIT_LOOKUP", "SUBMIT_PROFILE_CHECK", "SUBMITTING", "VERIFYING"].includes(snapshot?.state);
    const candidatePosition = row ? candidates.indexOf(row.rowNumber) + 1 : 0;
    return {
      mode: modes[snapshot?.state] || snapshot?.state || "IDLE",
      position: submitting ? `${Math.max(candidatePosition, 0)} of ${candidates.length} eligible` : `${rows.length ? (snapshot.currentRowIndex ?? 0) + 1 : 0} of ${rows.length}`,
      csvRow: row?.rowNumber ?? null,
      maskedMember: maskMember(row?.memberNumber),
      status: row?.status || "",
      candidateCount: candidates.length,
      verified,
      remaining: Math.max(0, candidates.length - verified),
    };
  }

  function mount(handlers) {
    const doc = handlers.documentRef || document;
    const host = element(doc, "section", "", { id: "phic-eprs-panel", "aria-label": "PhilHealth Contribution Uploader" });
    const style = element(doc, "style", `
      #phic-eprs-panel, #phic-eprs-panel * { box-sizing: border-box; }
      #phic-eprs-panel {
        position: fixed; top: 12px; right: 12px; z-index: 2147483647;
        width: min(360px, calc(100vw - 16px)); max-height: calc(100vh - 24px);
        display: flex; flex-direction: column; overflow: hidden;
        color: #f1f5f9; background: #111827; border: 1px solid #374151;
        border-radius: 12px; box-shadow: 0 16px 40px rgba(0,0,0,.35);
        font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      #phic-eprs-panel .phic-header { padding: 12px 14px; border-bottom: 1px solid #374151; background: linear-gradient(180deg,#1f2937,#151d2b); cursor: grab; touch-action: none; user-select: none; }
      #phic-eprs-panel .phic-header:active { cursor: grabbing; }
      #phic-eprs-panel .phic-title { margin: 0; font-size: 14px; font-weight: 700; }
      #phic-eprs-panel .phic-subtitle { margin-top: 4px; color: #cbd5e1; font-size: 12px; }
      #phic-eprs-controls { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px 14px; display: grid; gap: 10px; }
      #phic-eprs-panel label { display: grid; gap: 6px; color: #e5e7eb; }
      #phic-eprs-panel input[type=file], #phic-eprs-panel select { width: 100%; color: #cbd5e1; background: #0b1220; border: 1px solid #374151; border-radius: 7px; padding: 6px; }
      #phic-eprs-panel .phic-row { display: flex; flex-wrap: wrap; gap: 8px; }
      #phic-eprs-panel button { appearance: none; min-height: 36px; border: 1px solid #4b5563; border-radius: 8px; padding: 7px 10px; color: #f9fafb; background: #1f2937; font: inherit; font-weight: 600; cursor: pointer; }
      #phic-eprs-panel button:hover:not(:disabled) { background: #334155; }
      #phic-eprs-panel button:disabled { color: #cbd5e1; cursor: not-allowed; opacity: .58; }
      #phic-eprs-panel :focus-visible { outline: 2px solid #60a5fa; outline-offset: 2px; }
      #phic-eprs-panel .phic-status { min-height: 42px; padding: 9px; border: 1px solid #243041; border-radius: 9px; background: #0b1220; white-space: pre-wrap; overflow-wrap: anywhere; }
      #phic-eprs-panel progress { width: 100%; height: 12px; accent-color: #38bdf8; }
      #phic-eprs-panel .phic-small { color: #cbd5e1; font-size: 12px; }
      #phic-eprs-progress { padding: 10px 14px; border-top: 1px solid #374151; white-space: pre-line; }
      @media (max-width: 420px) { #phic-eprs-panel { top: 8px; right: 8px; width: calc(100vw - 16px); max-height: calc(100vh - 16px); } #phic-eprs-controls { padding: 10px; } }
    `);
    doc.head?.appendChild(style);
    const header = element(doc, "header", "", { class: "phic-header" });
    header.appendChild(element(doc, "h1", "PhilHealth Contribution Uploader", { class: "phic-title" }));
    header.appendChild(element(doc, "div", "CSV import, dry run, live update, and progress reporting", { class: "phic-subtitle" }));
    host.appendChild(header);
    const controls = element(doc, "div", "", { id: "phic-eprs-controls" });
    host.appendChild(controls);
    const progress = element(doc, "div", "Mode: IDLE | Record 0 of 0", { id: "phic-eprs-progress", role: "status", "aria-live": "polite" });
    host.appendChild(progress);

    const fileInput = element(doc, "input", "", { type: "file", accept: ".csv,text/csv", "aria-label": "Choose CSV file" });
    const memberSelect = element(doc, "select", "", { "aria-label": "Member column" });
    const salarySelect = element(doc, "select", "", { "aria-label": "Salary column" });
    const state = element(doc, "div", "", { id: "phic-eprs-state" });
    Object.assign(state.style, { flex: "0 0 auto", marginTop: "0", paddingTop: "0", borderTop: "0" });
    const status = element(doc, "div", "Import a CSV to begin.", { class: "phic-status", role: "status", "aria-live": "polite" });
    state.appendChild(status);

    const addField = (labelText, control) => {
      const label = element(doc, "label", `${labelText} `);
      label.appendChild(control);
      controls.appendChild(label);
    };
    addField("CSV file", fileInput);
    addField("Member column", memberSelect);
    addField("Salary column", salarySelect);
    controls.appendChild(state);

    const buttons = {};
    const primary = element(doc, "div", "", { class: "phic-row", role: "group", "aria-label": "Run actions" });
    const secondary = element(doc, "div", "", { class: "phic-row", role: "group", "aria-label": "Additional actions" });
    const downloadRow = element(doc, "div", "", { class: "phic-row", role: "group", "aria-label": "Download action" });
    [["dry", "Dry Run"], ["submit", "Live Update"], ["stop", "Stop"], ["resume", "Resume Checkpoint"], ["pause", "Pause"], ["download", "Download CSV"]].forEach(([key, label]) => {
      const button = element(doc, "button", label, { type: "button", "aria-label": label });
      buttons[key] = button;
      if (key === "dry" || key === "submit" || key === "stop") primary.appendChild(button);
      else if (key === "download") downloadRow.appendChild(button);
      else secondary.appendChild(button);
    });
    controls.append(primary, secondary, downloadRow);
    const progressBar = element(doc, "progress", "", { id: "phic-eprs-progress-bar", value: "0", max: "1", "aria-label": "Run progress" });
    controls.append(progressBar);
    const progressText = element(doc, "div", "0 / 0", { class: "phic-small", id: "phic-eprs-progress-text", "aria-live": "polite" });
    controls.appendChild(progressText);
    const mountRoot = doc.body?.tagName === "FRAMESET" ? doc.documentElement : doc.body;
    mountRoot.appendChild(host);

    let drag = null;
    header.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      const rect = host.getBoundingClientRect();
      drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
      host.style.left = `${rect.left}px`;
      host.style.top = `${rect.top}px`;
      host.style.right = "auto";
      header.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    header.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const maxLeft = Math.max(0, doc.defaultView.innerWidth - host.offsetWidth);
      const maxTop = Math.max(0, doc.defaultView.innerHeight - host.offsetHeight);
      host.style.left = `${Math.min(maxLeft, Math.max(0, event.clientX - drag.offsetX))}px`;
      host.style.top = `${Math.min(maxTop, Math.max(0, event.clientY - drag.offsetY))}px`;
    });
    const stopDragging = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
      if (header.hasPointerCapture(event.pointerId)) header.releasePointerCapture(event.pointerId);
    };
    header.addEventListener("pointerup", stopDragging);
    header.addEventListener("pointercancel", stopDragging);
    header.addEventListener("lostpointercapture", stopDragging);
    doc.defaultView.addEventListener("resize", () => {
      const rect = host.getBoundingClientRect();
      if (host.style.left === "") return;
      host.style.left = `${Math.min(Math.max(0, doc.defaultView.innerWidth - host.offsetWidth), rect.left)}px`;
      host.style.top = `${Math.min(Math.max(0, doc.defaultView.innerHeight - host.offsetHeight), rect.top)}px`;
    });

    let lastRun = null;
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const imported = await handlers.onImport(await file.text());
      if (imported?.parsed) setHeaders(imported.parsed.originalHeaders);
    });
    buttons.dry.addEventListener("click", () => handlers.onStartDryRun(getMapping()));
    buttons.resume.addEventListener("click", () => handlers.onResume(getMapping()));
    buttons.submit.addEventListener("click", () => handlers.onStartSubmit(getMapping()));
    buttons.pause.addEventListener("click", () => handlers.onPause());
    buttons.stop.addEventListener("click", () => handlers.onStop());
    buttons.download.addEventListener("click", () => handlers.onDownload(lastRun));

    function setHeaders(headers) {
      memberSelect.replaceChildren();
      salarySelect.replaceChildren();
      headers.forEach((header) => {
        memberSelect.appendChild(element(doc, "option", header.trim(), { value: header }));
        salarySelect.appendChild(element(doc, "option", header.trim(), { value: header }));
      });
      const phic = headers.find((header) => P.csv.normalizeHeader(header) === "PHIC");
      if (phic) memberSelect.value = phic;
      const candidates = headers.filter((header) => !["PHIC", "NAME", "EMPCODE"].includes(P.csv.normalizeHeader(header)));
      if (candidates.length) salarySelect.value = candidates[0];
      buttons.dry.disabled = false;
      buttons.submit.disabled = false;
    }

    function getMapping() {
      return { memberColumn: memberSelect.value, salaryColumn: salarySelect.value };
    }

    function safeCount(value) {
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    }

    function confirmUpdates(summary, resume = false) {
      const totalCount = safeCount(summary?.totalCount);
      const candidateCount = Math.min(safeCount(summary?.candidateCount), totalCount);
      const remainingCount = safeCount(summary?.remainingCount);
      const message = resume
        ? `Resume automatic updates for ${remainingCount} remaining rows?`
        : candidateCount < totalCount
          ? `Process ${candidateCount} eligible rows from ${totalCount} CSV rows?`
          : `Process all ${totalCount} validated CSV rows?`;
      return Boolean(doc.defaultView.confirm(message));
    }

    function renderProgress(snapshot) {
      const view = progressView(snapshot);
      const rows = snapshot?.rows || [];
      const row = snapshot?.rows?.[snapshot.currentRowIndex];
      const diagnostics = P.storage.sanitizeDiagnostics(row);
      const stopReason = P.storage.sanitizeDiagnostics({ stopReason: snapshot?.resultMessage }).stopReason;
      const lines = [
        `Mode: ${view.mode}`,
        `Record ${view.position}${view.csvRow === null ? "" : ` · CSV row ${view.csvRow}`}`,
        `Member ${view.maskedMember}${view.status ? ` · ${view.status}` : ""}`,
      ];
      if (diagnostics.processingStage) {
        lines.push(`Stage: ${diagnostics.processingStage}${diagnostics.processingStage === "LOOKUP_RETRY" ? ` · Retry ${diagnostics.lookupRetryCount} of 2` : ""}`);
      }
      if (snapshot?.state === "STOPPED_ERROR" && stopReason) {
        lines.push(`Stop reason: ${stopReason}`);
      }
      if (snapshot?.mode === "UPDATE") lines.push(`Verified ${view.verified} · Remaining ${view.remaining}`);
      progress.textContent = lines.join("\n");
      const total = rows.length;
      const current = total ? Math.min(total, (snapshot?.currentRowIndex ?? 0) + (snapshot?.state === "IDLE" ? 0 : 1)) : 0;
      progressBar.max = Math.max(total, 1);
      progressBar.value = current;
      progressText.textContent = `${current} / ${total}`;
    }

    function render(snapshot) {
      lastRun = snapshot;
      const locked = snapshot && !["IDLE", "VALIDATING"].includes(snapshot.state);
      memberSelect.disabled = Boolean(locked);
      salarySelect.disabled = Boolean(locked);
      const row = snapshot?.rows?.[snapshot.currentRowIndex];
      renderProgress(snapshot);
      status.textContent = snapshot ? `State: ${snapshot.state}${row ? ` | Row ${row.rowNumber} | ${maskMember(row.memberNumber)} | ${row.status}` : ""}` : "Import a CSV to begin.";
      buttons.submit.disabled = Boolean(snapshot && !["IDLE", "VALIDATING", "DRY_COMPLETE", "COMPLETE", "STOPPED_ERROR"].includes(snapshot.state));
      buttons.pause.disabled = !snapshot || ["COMPLETE", "STOPPED_ERROR", "PAUSED_USER"].includes(snapshot.state);
      buttons.stop.disabled = !snapshot || ["COMPLETE", "DRY_COMPLETE", "STOPPED_ERROR", "PAUSED_USER", "PAUSED_SESSION"].includes(snapshot.state);
    }

    function setMessage(message) {
      status.textContent = String(message || "");
    }

    function setResumeAvailable(available) {
      buttons.resume.disabled = !available;
    }

    buttons.stop.disabled = true;
    buttons.pause.disabled = true;
    buttons.resume.disabled = true;
    buttons.dry.disabled = true;
    buttons.submit.disabled = true;

    return { buttons, confirmUpdates, destroy: () => { host.remove(); style.remove(); }, fileInput, getMapping, host, memberSelect, render, salarySelect, setHeaders, setMessage, setResumeAvailable };
  }

  P.panel = { maskMember, mount, progressView };
})(globalThis.PHICEPRS);

// source: src/results.js
(function installResults(P) {
  "use strict";

  const AUDIT_HEADERS = ["selected_salary_column", "desired_salary", "automation_status", "result_message", "dry_run_at", "submitted_at", "verified_at", "attempt_count", "lookup_retry_count", "processing_stage", "stop_reason", "run_id"];
  const MESSAGES = Object.freeze({
    READY: "Ready for dry-run.", DRY_OK: "Eligible active member verified.",
    UPDATED_VERIFIED: "Salary update verified by read-back.", STATUS_MISMATCH: "Member is not Active; no change made.",
    NO_CHANGE: "Salary already matches; no change submitted.",
    INVALID_PHIC: "Invalid member number.", INVALID_SALARY: "Invalid salary value.",
    DUPLICATE_MEMBER_NUMBER: "Duplicate member number; row skipped.",
    NOT_FOUND: "No exact member match found.", AMBIGUOUS_MATCH: "Multiple matching results; no change made.",
    SUBMIT_REJECTED: "Portal rejected the update; batch stopped.", VERIFY_UNKNOWN: "Update outcome could not be verified; batch stopped.",
    PORTAL_ERROR: "Unexpected portal response; batch stopped.", STOPPED_ERROR: "Automation stopped on an unexpected state.",
  });

  function append(originalRows, run) {
    return originalRows.map((raw, index) => {
      const row = run.rows[index] || {};
      const diagnostics = P.storage.sanitizeDiagnostics(row);
      return {
        ...raw,
        selected_salary_column: run.mapping.salaryColumn,
        desired_salary: row.desiredSalary || "",
        automation_status: row.status || "",
        result_message: MESSAGES[row.status] || MESSAGES.PORTAL_ERROR,
        dry_run_at: row.dryRunAt || "",
        submitted_at: row.submittedAt || "",
        verified_at: row.verifiedAt || "",
        attempt_count: row.attemptCount ?? 0,
        lookup_retry_count: diagnostics.lookupRetryCount,
        processing_stage: diagnostics.processingStage,
        stop_reason: diagnostics.stopReason,
        run_id: run.runId,
      };
    });
  }

  function download(rows, filename, documentRef = document, urlApi = URL) {
    if (!rows.length) throw new Error("No result rows are available");
    const headers = Object.keys(rows[0]);
    const blob = new Blob([P.csv.serialize(headers, rows)], { type: "text/csv;charset=utf-8" });
    const href = urlApi.createObjectURL(blob);
    const anchor = documentRef.createElement("a");
    anchor.href = href;
    anchor.download = filename;
    anchor.hidden = true;
    documentRef.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => urlApi.revokeObjectURL(href), 0);
  }

  P.results = { AUDIT_HEADERS, MESSAGES, append, download };
})(globalThis.PHICEPRS);

// source: src/main.js
(function installApplication(P) {
  "use strict";

  function timestamp() {
    return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  }

  function createApplication({ documentRef = document, panelDocument = documentRef, frame, storageAdapter } = {}) {
    const mainFrame = frame || documentRef.querySelector('frame[name="mainFrame"]');
    if (!mainFrame) throw new Error("EPRS main frame is unavailable");
    const store = P.storage.createStore(storageAdapter);
    let parsed = null;
    let csvText = null;
    let fingerprint = null;
    let checkpoint = null;
    let controller = null;

    async function safely(work) {
      try { return await work(); }
      catch (_) { panel.setMessage("Operation stopped. Review the CSV, session, and page state."); return null; }
    }

    async function importCsv(text) {
      csvText = String(text);
      parsed = P.csv.parse(csvText);
      fingerprint = await P.storage.sha256(csvText);
      const snapshot = controller.getSnapshot();
      const terminalStates = [P.state.STATES.COMPLETE, P.state.STATES.STOPPED_ERROR, P.state.STATES.DRY_COMPLETE];
      if (snapshot && snapshot.fileFingerprint !== fingerprint && !terminalStates.includes(snapshot.state)) {
        await store.clearCheckpoint();
        checkpoint = null;
        controller.abandon();
      } else {
        checkpoint = await store.loadCheckpoint();
      }
      panel.setResumeAvailable(Boolean(checkpoint && checkpoint.fileFingerprint === fingerprint));
      return { parsed, fingerprint };
    }

    async function prepare(mapping) {
      if (!parsed) throw new Error("Import a CSV first");
      const prepared = P.validation.prepare(parsed, mapping);
      if (!prepared.rows.some((row) => row.status === "READY")) {
        throw new Error(`CSV validation failed: ${prepared.errors.join(", ") || "no usable rows"}`);
      }
      return prepared;
    }

    const panel = P.panel.mount({
      documentRef: panelDocument,
      onImport: (text) => safely(() => importCsv(text)),
      onStartDryRun: (mapping) => safely(async () => {
        const prepared = await prepare(mapping);
        await store.clearCheckpoint();
        checkpoint = null;
        panel.setResumeAvailable(false);
        await controller.startDryRun(prepared, fingerprint, mapping);
      }),
      onResume: (mapping) => safely(async () => {
        const prepared = await prepare(mapping);
        if (!checkpoint) throw new Error("No matching checkpoint is available");
        const summary = await controller.previewResume(prepared, fingerprint, mapping, checkpoint);
        if (summary.mode === P.state.MODES.UPDATE && !panel.confirmUpdates(summary, true)) return;
        await controller.resume(prepared, fingerprint, mapping, checkpoint);
      }),
      onStartSubmit: (mapping) => safely(async () => {
        const prepared = await prepare(mapping);
        const plan = await controller.previewSubmission(prepared, fingerprint, mapping);
        if (!panel.confirmUpdates({ totalCount: prepared.rows.length, candidateCount: plan.rowNumbers.length })) return;
        await controller.startSubmission(prepared, fingerprint, mapping);
      }),
      onPause: () => safely(() => controller.pause()),
      onStop: () => safely(() => controller.stop()),
      onDownload: () => safely(async () => {
        const run = controller.getSnapshot();
        const rawRows = controller.getRawRows();
        if (!run || !rawRows || rawRows.length !== run.rows.length) throw new Error("No results are available");
        const rows = P.results.append(rawRows, run);
        P.results.download(rows, `philhealth-eprs-results-${run.runId}-${timestamp()}.csv`, panelDocument, URL);
      }),
    });

    controller = P.controller.create({
      frame: mainFrame,
      stateStore: store,
      clock: { delay: (ms = 750) => new Promise((resolve) => setTimeout(resolve, Math.max(750, ms))), now: () => new Date().toISOString() },
      ui: panel,
      eprs: P.eprs,
      actions: P.actions,
    });

    return { controller, destroy: () => panel.destroy(), importCsv, panel };
  }

  P.createApplication = createApplication;
  P.start = ({ documentRef = document, storageAdapter } = {}) => {
    const topFrame = documentRef.querySelector('frame[name="topFrame"]');
    if (!topFrame) throw new Error("EPRS header frame is unavailable");

    const mountInHeader = () => {
      if (!topFrame.contentDocument?.body) return null;
      return createApplication({ documentRef, panelDocument: documentRef, storageAdapter });
    };

    const application = mountInHeader();
    if (application) return application;
    topFrame.addEventListener("load", mountInHeader, { once: true });
    return null;
  };

  P.bootstrap = ({ windowRef = window, documentRef = document, storageAdapter } = {}) => {
    if (windowRef.location.pathname !== "/header.asp") return null;
    if (windowRef.__PHIC_EPRS_STARTED__) return null;

    const outerDocument = windowRef.top.document;
    if (!outerDocument.querySelector('frame[name="mainFrame"]')) {
      throw new Error("EPRS main frame is unavailable");
    }

    windowRef.__PHIC_EPRS_STARTED__ = true;
    try {
      return createApplication({ documentRef: outerDocument, panelDocument: outerDocument, storageAdapter });
    } catch (error) {
      delete windowRef.__PHIC_EPRS_STARTED__;
      throw error;
    }
  };

  if (typeof window !== "undefined") P.bootstrap();
})(globalThis.PHICEPRS);

})();
