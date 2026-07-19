/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// The only DOM code in the repo. Compiled by tsconfig.client.json straight to
// public/client.js and loaded as an ES module; no bundler, no framework. All
// decisions live in view-model.ts, so this file is deliberately dumb: fetch,
// guard, render, schedule. The lib references above scope DOM types to this
// file's compilation without widening the server tsconfigs.
//
// Auth model: the UI owns its credential. A login form collects the
// passphrase, sessionStorage keeps it for the tab's lifetime, and every fetch
// sends it as a Bearer header. Browsers do not reliably reattach basic-auth
// credentials to fetch() calls, so the app never depends on the browser's
// credential cache; a 401 anywhere drops cleanly back to the login view.
//
// Loop discipline (README "Decisions"): recursive setTimeout, never
// setInterval, so a slow status read cannot stack requests. A hidden tab
// schedules nothing; visibilitychange restarts the loop.

import {
  nextPollDelay,
  observedAgoText,
  parseCommandResponse,
  parseStatusResponse,
  shouldAcceptVersion,
  toViewModel,
  viewModelFromState,
  type ViewModel,
} from "./view-model.js";
import type { Command } from "./transitions.js";

/** Poll cadence before the first successful status read lands. */
const BOOTSTRAP_RETRY_MS = 5_000;
/** sessionStorage: survives reloads, dies with the tab. Deliberately not localStorage. */
const PASSPHRASE_KEY = "turntable-passphrase";

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`markup out of sync: missing #${id}`);
  return el;
}

function buttonById(id: string): HTMLButtonElement {
  const el = byId(id);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`markup out of sync: #${id} is not a button`);
  return el;
}

const loginView = byId("login");
const loginForm = byId("login-form");
const loginInput = byId("passphrase");
const loginError = byId("login-error");
const cardView = byId("card");
const stateLabel = byId("state-label");
const stateDetail = byId("state-detail");
const spinner = byId("spinner");
const actionButton = buttonById("action");
const banner = byId("banner");
const bannerText = byId("banner-text");
const retryButton = buttonById("retry");
const observedEl = byId("observed");
const versionEl = byId("version");
const lockButton = buttonById("lock");

// --- state ------------------------------------------------------------------

let passphrase: string | null = readStoredPassphrase();
let currentVm: ViewModel | null = null;
let lastVersion: number | null = null;
let lastObservedAt: number | null = null;
let pollTimer: number | null = null;
let commandInFlight = false;
// Bumped on every command so a status read already in flight when the user
// clicked cannot land afterwards and roll the view back (the other half of
// the version guard, which cannot see responses that have not arrived yet).
let pollEpoch = 0;

function readStoredPassphrase(): string | null {
  try {
    return sessionStorage.getItem(PASSPHRASE_KEY);
  } catch {
    return null; // storage blocked (private mode policies): login each load
  }
}

function storePassphrase(value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(PASSPHRASE_KEY);
    else sessionStorage.setItem(PASSPHRASE_KEY, value);
  } catch {
    // Storage failures degrade to per-load login, never to a crash.
  }
}

function authHeaders(): Record<string, string> {
  return passphrase === null
    ? { accept: "application/json" }
    : { accept: "application/json", authorization: `Bearer ${passphrase}` };
}

// --- view switching ---------------------------------------------------------

function showLogin(message: string): void {
  clearPollTimer();
  passphrase = null;
  storePassphrase(null);
  currentVm = null;
  lastVersion = null;
  cardView.hidden = true;
  loginView.hidden = false;
  loginError.textContent = message;
  if (loginInput instanceof HTMLInputElement) {
    loginInput.value = "";
    loginInput.focus();
  }
}

function showCard(): void {
  loginView.hidden = true;
  cardView.hidden = false;
}

/** Every 401 funnels here: the credential is wrong or expired, say so once. */
function handleUnauthorized(): void {
  showLogin(passphrase === null ? "" : "Passphrase rejected. Try again.");
}

// --- rendering --------------------------------------------------------------

function render(vm: ViewModel): void {
  currentVm = vm;
  cardView.dataset["tone"] = vm.stateTone;
  stateLabel.textContent = vm.stateLabel;
  stateDetail.textContent = vm.detail;
  spinner.hidden = !vm.showSpinner;
  actionButton.textContent = vm.buttonLabel;
  actionButton.disabled = !vm.buttonEnabled || commandInFlight;
}

function renderFooter(): void {
  if (lastObservedAt !== null) observedEl.textContent = observedAgoText(lastObservedAt, Date.now());
  if (lastVersion !== null) versionEl.textContent = `v${lastVersion}`;
}

/** Retryable failure: the banner shows, the last good view stays rendered. */
function showError(message: string): void {
  banner.dataset["kind"] = "error";
  bannerText.textContent = message;
  retryButton.hidden = false;
  banner.hidden = false;
}

/** Informational notice (409 conflict): no retry button, next poll clears it. */
function showNotice(message: string): void {
  banner.dataset["kind"] = "notice";
  bannerText.textContent = message;
  retryButton.hidden = true;
  banner.hidden = false;
}

function clearBanner(): void {
  banner.hidden = true;
}

// --- polling ----------------------------------------------------------------

/** Every async entry point routes through here so no rejection floats. */
function fireAndForget(work: Promise<void>): void {
  void work.catch((e: unknown) => {
    showError(e instanceof Error ? e.message : "unexpected UI error");
  });
}

function clearPollTimer(): void {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function scheduleNext(): void {
  clearPollTimer();
  if (document.hidden || passphrase === null) return;
  const delay = currentVm === null ? BOOTSTRAP_RETRY_MS : nextPollDelay(currentVm, false);
  if (delay === null) return;
  pollTimer = window.setTimeout(() => {
    pollTimer = null;
    fireAndForget(pollOnce());
  }, delay);
}

async function pollOnce(): Promise<void> {
  await refreshStatus();
  scheduleNext();
}

async function refreshStatus(): Promise<void> {
  if (passphrase === null) return;
  const epoch = pollEpoch;
  // Every branch below re-checks the epoch after awaiting: a read superseded
  // by a command mutates nothing, not even the error banner.
  let body: unknown;
  try {
    const res = await fetch("/api/status", { headers: authHeaders() });
    if (epoch !== pollEpoch) return;
    if (res.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!res.ok) {
      showError(`status read failed (HTTP ${res.status})`);
      return;
    }
    body = await res.json();
  } catch {
    if (epoch !== pollEpoch) return;
    showError("network error while reading status; retrying");
    return;
  }
  if (epoch !== pollEpoch) return;
  const status = parseStatusResponse(body);
  if (status === null) {
    showError("status response did not match the expected shape");
    return;
  }
  if (!shouldAcceptVersion(lastVersion, status.version)) return; // stale, discard
  lastVersion = status.version;
  lastObservedAt = status.observedAt;
  clearBanner();
  render(toViewModel(status));
  renderFooter();
}

// --- the button -------------------------------------------------------------

async function sendCommand(command: Command): Promise<void> {
  commandInFlight = true;
  pollEpoch += 1;
  clearPollTimer();
  // Optimistic: the button drops and the spinner shows before the wire answers.
  actionButton.disabled = true;
  spinner.hidden = false;
  try {
    let body: unknown;
    let httpStatus: number;
    try {
      const res = await fetch(`/api/${command}`, {
        method: "POST",
        headers: authHeaders(),
      });
      httpStatus = res.status;
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      body = await res.json();
    } catch {
      showError(`network error while sending ${command}; nothing is assumed, the next poll re-reads`);
      return;
    }
    const response = parseCommandResponse(body);
    if (response === null) {
      showError(`unexpected ${command} response shape (HTTP ${httpStatus})`);
      return;
    }
    if (response.outcome === "conflict") {
      showNotice("Conflict: a lifecycle operation is already in flight. Showing its current state.");
    } else {
      clearBanner();
    }
    // Render from the RESPONSE view immediately; the poll below re-verifies.
    render(viewModelFromState(response.view));
  } finally {
    commandInFlight = false;
    if (currentVm !== null) {
      actionButton.disabled = !currentVm.buttonEnabled;
      spinner.hidden = !currentVm.showSpinner;
    }
    if (passphrase !== null) {
      // Invalidate: the response view is a hint, status is the truth.
      fireAndForget(pollOnce());
    }
  }
}

// --- login ------------------------------------------------------------------

async function attemptLogin(candidate: string): Promise<void> {
  passphrase = candidate;
  // Probe with a status read before committing to storage: a wrong passphrase
  // never gets persisted, and a right one lands with data already in hand.
  let res: Response;
  try {
    res = await fetch("/api/status", { headers: authHeaders() });
  } catch {
    passphrase = null;
    loginError.textContent = "Network error. Try again.";
    return;
  }
  if (res.status === 401) {
    passphrase = null;
    loginError.textContent = "Passphrase rejected.";
    return;
  }
  if (!res.ok) {
    passphrase = null;
    loginError.textContent = `Server error (HTTP ${res.status}). Try again.`;
    return;
  }
  storePassphrase(candidate);
  loginError.textContent = "";
  showCard();
  const body: unknown = await res.json().catch(() => null);
  const status = parseStatusResponse(body);
  if (status !== null) {
    lastVersion = status.version;
    lastObservedAt = status.observedAt;
    render(toViewModel(status));
    renderFooter();
  }
  scheduleNext();
}

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!(loginInput instanceof HTMLInputElement)) return;
  const candidate = loginInput.value;
  if (candidate === "") {
    loginError.textContent = "Enter the passphrase.";
    return;
  }
  fireAndForget(attemptLogin(candidate));
});

lockButton.addEventListener("click", () => {
  showLogin("");
});

actionButton.addEventListener("click", () => {
  if (commandInFlight || currentVm === null || !currentVm.buttonEnabled) return;
  fireAndForget(sendCommand(currentVm.buttonCommand));
});

retryButton.addEventListener("click", () => {
  clearBanner();
  clearPollTimer();
  fireAndForget(pollOnce());
});

document.addEventListener("visibilitychange", () => {
  clearPollTimer();
  if (!document.hidden && passphrase !== null) fireAndForget(pollOnce());
});

// --- footer clock -----------------------------------------------------------

// Local text only, no network, so it ticks regardless of visibility.
function tickObservedAgo(): void {
  renderFooter();
  window.setTimeout(tickObservedAgo, 1_000);
}

// --- boot -------------------------------------------------------------------

if (passphrase === null) {
  showLogin("");
} else {
  showCard();
  fireAndForget(pollOnce());
}
tickObservedAgo();
