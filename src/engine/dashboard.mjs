/**
 * web/dashboard.mjs — AiSearch: JEDEN dashboard w terminalu.
 *
 * Zamknięty ekosystem w jednym widoku: podpisane panele etapów (plan, propose,
 * resolve, falsify, learn) + panel wyników + panel LOGU w języku naturalnym
 * (narrate() z pipeline.mjs — jeden zapis, dwa widoki).
 *
 * Dwa tryby:
 *   TUI   — pełny ekran alternatywny, panele z ramkami, render throttlowany (~10/s)
 *   tekst — gdy brak TTY (potok, CI): ten sam strumień zdarzeń jako linie tekstu
 *
 * Zero zależności npm. ANSI + pomiar terminala.
 */

import { narrate } from './pipeline.mjs';

const ESC = '\x1b[';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[90m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';

const COLORS = { cyan: CYAN, green: GREEN, red: RED, yellow: YELLOW, magenta: MAGENTA, dim: DIM, bold: BOLD };

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const visible = (s) => strip(s).length;
const pad = (s, w) => {
  const v = visible(s);
  return v >= w ? strip(s).slice(0, w) : s + ' '.repeat(w - v);
};

const BOX = { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };

function frame(title, lines, width, color = CYAN) {
  const inner = width - 2;
  const top = `${color}${BOX.tl}${BOX.h} ${BOLD}${title}${RESET}${color}${' '.repeat(Math.max(0, inner - visible(title) - 1))}${BOX.tr}${RESET}`;
  const body = lines.map((l) => `${color}${BOX.v}${RESET}${pad(l, inner)}${color}${BOX.v}${RESET}`);
  const bottom = `${color}${BOX.bl}${BOX.h.repeat(inner)}${BOX.br}${RESET}`;
  return [top, ...body, bottom];
}

/** Podziel tekst na linie mieszczące się w szerokości. */
function wrap(text, width) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    let line = raw;
    while (strip(line).length > width) {
      out.push(line.slice(0, width));
      line = line.slice(width);
    }
    out.push(line);
  }
  return out;
}

export class Dashboard {
  /**
   * @param {object} opts
   * @param {boolean} opts.tty wymuś tryb (domyślnie wykryty)
   * @param {number} opts.maxLogLines ile linii logu trzymać
   */
  constructor({ tty = process.stdout.isTTY === true, maxLogLines = 200 } = {}) {
    this.tty = tty;
    this.maxLogLines = maxLogLines;
    this.state = {
      plan: [],
      propose: [],
      resolve: [],
      falsify: [],
      learn: [],
      output: [],
      cache: [],
      log: [],
      final: null,
      query: '',
      startedAt: Date.now(),
    };
    this.opened = false;
    this.lastRender = 0;
    this.minRenderMs = 80;
  }

  colorize(kind) {
    switch (kind) {
      case 'resolved':
        return GREEN;
      case 'dead':
      case 'error':
      case 'rejected':
        return RED;
      case 'archived':
      case 'stale':
        return YELLOW;
      case 'cache-hit':
        return DIM;
      default:
        return CYAN;
    }
  }

  /** Wejście zdarzenia z pipeline'u. */
  event(ev) {
    const line = this.state.log.length;
    const text = narrate(ev);
    if (ev.query) this.state.query = ev.query;

    const push = (pane, value) => this.state[pane].push(value);

    switch (ev.stage) {
      case 'plan':
        push('plan', text);
        break;
      case 'propose':
        push('propose', text);
        break;
      case 'resolve':
        push('resolve', `${this.colorize(ev.type)}${text}${RESET}`);
        break;
      case 'falsify':
        push('falsify', text);
        break;
      case 'learn':
        push('learn', text);
        break;
      case 'final':
        this.state.final = ev.result || null;
        if (ev.result) {
          push('output', `${BOLD}gotowe${RESET}: ${ev.result.results.length} wyników w ${ev.result.stats?.ms ?? '?'} ms`);
        }
        break;
      default:
        push('plan', text);
    }

    const stamp = new Date().toISOString().slice(11, 19);
    const color = this.colorize(ev.type);
    this.state.log.push(`${DIM}${stamp}${RESET} ${color}${strip(text)}${RESET}`);
    if (this.state.log.length > this.maxLogLines) this.state.log.shift();
    return line;
  }

  /** Ręczny wpis do logu (poza pipeline'm). */
  pushLog(text, kind = 'dim') {
    const stamp = new Date().toISOString().slice(11, 19);
    this.state.log.push(`${DIM}${stamp}${RESET} ${COLORS[kind] || CYAN}${strip(text)}${RESET}`);
    if (this.state.log.length > this.maxLogLines) this.state.log.shift();
  }

  open() {
    if (!this.tty || this.opened) return;
    process.stdout.write(`${ESC}?1049h${ESC}?25l`);
    this.opened = true;
  }

  close() {
    if (!this.tty || !this.opened) return;
    process.stdout.write(`${ESC}?25h${ESC}?1049l`);
    this.opened = false;
  }

  /** Zbuduj pełny ekran po throttle. */
  render(force = false) {
    if (!this.tty) return;
    const now = Date.now();
    if (!force && now - this.lastRender < this.minRenderMs) return;
    this.lastRender = now;

    const cols = process.stdout.columns || 100;
    const rows = process.stdout.rows || 30;
    if (cols < 70 || rows < 20) {
      this.tty = false;
      this.pushLog('terminal za mały — przełączam na tryb tekstowy');
      this.renderText();
      return;
    }

    const W = Math.max(70, Math.min(cols, 140));
    const half = Math.floor((W - 1) / 2);
    const s = this.state;
    const tail = (arr, n) => arr.slice(-n);

    const header = [
      `${BOLD}${CYAN} AiSearch ${RESET}${DIM}—${RESET} ${BOLD}${strip(s.query).slice(0, 60)}${RESET}`,
      `${DIM} zamknięty ekosystem: in → plan → propose → resolve → falsify → learn → out ${RESET}`,
    ];

    const planPane = frame('PLAN', tail(s.plan, 3), half, CYAN);
    const proposePane = frame('PROPOSE', tail(s.propose, 3), W - half - 1, CYAN);

    const resolveRows = tail(s.resolve, Math.max(4, rows - 24));
    const resolvePane = frame('RESOLVE (równolegle · auto-korektor)', resolveRows, W, GREEN);

    const falsifyPane = frame('FALSIFY (werdykt + scoring)', tail(s.falsify, 3), half, YELLOW);
    const learnPane = frame('LEARN (linklog → prior → drift)', tail(s.learn, 3), W - half - 1, MAGENTA);

    const outputLines = s.final
      ? s.final.results.slice(0, Math.max(3, rows - 26)).map((r, i) => {
          const flags = [r.repaired ? 'naprawiony' : null, r.archived ? 'archiwum' : null, r.fromCache ? 'cache' : null]
            .filter(Boolean)
            .join(',');
          const title = (r.title || '').slice(0, Math.max(10, W - 60));
          return `${BOLD}${String(i + 1).padStart(2)}${RESET} ${(r.score ?? 0).toFixed(2)} ${title} ${DIM}${r.url.replace(/^https?:\/\//, '').slice(0, 40)}${flags ? ` [${flags}]` : ''}${RESET}`;
        })
      : [`${DIM}… czekam na wyniki${RESET}`];
    const outputPane = frame('WYNIKI (ranked + provenance)', outputLines, W, GREEN);

    const logPane = frame('LOG (mowa naturalna)', tail(s.log, Math.max(4, rows - outputLines.length - 22)), W, DIM);

    const stage = s.final
      ? `${GREEN}zakończono${RESET}`
      : s.resolve.length
        ? `${CYAN}resolve${RESET}`
        : s.propose.length
          ? `${CYAN}propose${RESET}`
          : `${CYAN}plan${RESET}`;

    const status = `${DIM} ${stage} · cache:${s.cache.length || 0} · zdarzenia:${s.log.length} · ${Math.round((Date.now() - s.startedAt) / 1000)}s ${RESET}`;

    // Złóż ekran: dwa panele obok siebie = zip ich linii.
    const sideBySide = (left, right) => {
      const n = Math.max(left.length, right.length);
      const out = [];
      for (let i = 0; i < n; i += 1) {
        const l = left[i] || ' '.repeat(half + 1);
        const r = right[i] || '';
        out.push(l + r);
      }
      return out;
    };

    const screen = [
      ...header,
      ...sideBySide(planPane, proposePane),
      ...resolvePane,
      ...sideBySide(falsifyPane, learnPane),
      ...outputPane,
      ...logPane,
      status.slice(0, W),
    ];

    process.stdout.write(`${ESC}2J${ESC}H`);
    process.stdout.write(screen.slice(0, rows - 1).map((l) => strip(l).slice(0, cols)).join('\r\n'));
    process.stdout.write('\r\n');
  }

  /** Tryb tekstowy: ten sam strumień zdarzeń jako czytelne linie. */
  renderText(force = false) {
    if (this._lastText === undefined) this._lastText = 0;
    const now = Date.now();
    if (!force && now - this._lastText < 60) return;
    this._lastText = now;
    const pending = this.state.log.slice(this._printed || 0);
    for (const line of pending) process.stdout.write(`${strip(line)}\n`);
    this._printed = this.state.log.length;
  }
}

/**
 * PomoSC: przbieg zapytania z podpiętym dashboardem.
 * Zwraca finalny wynik (dashboard można przerwać w finally).
 */
export async function searchWithDashboard(aisearch, spec, { dashboard, onEvent } = {}) {
  const dash = dashboard || new Dashboard({});
  if (dash.tty) dash.open();
  let final = null;
  try {
    for await (const ev of aisearch.run(spec)) {
      dash.event(ev);
      if (dash.tty) dash.render();
      else dash.renderText();
      if (onEvent) onEvent(ev);
      if (ev.type === 'final') final = ev.result;
    }
    if (final) {
      dash.event({ stage: 'final', type: 'done', message: 'koniec' });
      if (dash.tty) dash.render(true);
    }
  } finally {
    if (!dash.tty) dash.renderText();
  }
  return final;
}
