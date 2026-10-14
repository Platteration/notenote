// The audit job's one step (CONVENTIONS.md, "CI"). The same file, byte for byte, in every npm
// repository with a lockfile, and pinned by hash in test/conventions.mjs. It uses Node's built-in
// modules and npm, and installs nothing: `npm audit --omit=dev --json` reads the lockfile, and every
// advisory at high or above fails the job unless .github/audit/accepted.json accepts it.
//
// An entry accepts one advisory for one package, at the severity it was accepted at, for a reason,
// along named routes, until a date. It stops accepting, and the job goes red: once the date has
// come; when the date is more than MAX_DAYS away; when npm rates the advisory above the severity
// the entry names; when the package has a release outside the advisory's range that an installed
// copy's dependents can take (newer than that copy, in its major: a fix exists, so take it, then
// remove the entry); when a route it names is not a chain of production dependencies in the
// lockfile ending at a copy npm reports; when npm reports a copy no route reaches; when a direct
// dependency reaches a reported copy and no route starts there; and when npm no longer reports
// what it accepts. A release outside the range on a newer major is named in the log and does not
// fail the job, since no dependent can take it without moving to that major. Routes are read from
// the lockfile, not from npm's report, because which dependents npm marks vulnerable varies from
// run to run while the lockfile does not. Anything this script cannot read (a report, a lockfile,
// a range, a list of releases) fails the job rather than passing it. test/conventions.mjs imports
// check() and run() and drives them over made-up reports and a stand-in npm, and runs this file
// itself against a stand-in npm, so each rule is held on every push, offline.
//
// Host globals are reached through globalThis, so the file lints under every stack's ESLint
// configuration without declaring an environment.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACCEPTED = '.github/audit/accepted.json';
export const MAX_DAYS = 90;
/** Severities that do not fail the job: what `--audit-level=high` let through, and no more. */
const BELOW = new Set(['info', 'low', 'moderate']);
/** The severities an entry can accept, in order: npm's rating above the entry's fails it. */
const RANK = { high: 1, critical: 2 };
const FIELDS = ['advisory', 'package', 'severity', 'paths', 'reason', 'expires'];
const GHSA = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/;
const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const DAY = 86_400_000;

/** A version as [major, minor, patch, prerelease identifiers], or null for anything else. */
export function parseVersion(text) {
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(typeof text === 'string' ? text.trim() : '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split('.') : []] : null;
}

/** Semantic Versioning 2.0.0 precedence: -1, 0 or 1. */
export function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  const [x, y] = [a[3], b[3]];
  if (x.length === 0 || y.length === 0) return x.length === y.length ? 0 : x.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if (i >= x.length) return -1;
    if (i >= y.length) return 1;
    if (x[i] === y[i]) continue;
    const [nx, ny] = [/^\d+$/.test(x[i]), /^\d+$/.test(y[i])];
    if (nx && ny) return Number(x[i]) < Number(y[i]) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** Whether `version` is in the major of `installed`, as a caret range reads it: the same major
 *  from 1.0.0, the same minor below it, the same patch below 0.1.0. */
export function sameMajor(version, installed) {
  if (installed[0] > 0) return version[0] === installed[0];
  if (installed[1] > 0) return version[0] === 0 && version[1] === installed[1];
  return version[0] === 0 && version[1] === 0 && version[2] === installed[2];
}

/** An advisory's range, as alternatives of [operator, version] conditions: the forms npm writes
 *  (`<=3.0.3`, `>=2.0.0 <2.3.1`, `1.0.0 - 1.0.10`, `*`, joined by `||`). Any other form throws. */
export function parseRange(range) {
  const need = (v) => {
    const parsed = parseVersion(v);
    if (!parsed) throw new Error(`a range this script does not read: ${JSON.stringify(range)}`);
    return parsed;
  };
  if (typeof range !== 'string') need('');
  return range.split('||').map((part) => {
    const set = part.trim().replace(/(<=|>=|<|>|=)\s+/g, '$1');
    if (set === '*') return [];
    const hyphen = /^(\S+) - (\S+)$/.exec(set);
    if (hyphen) return [['>=', need(hyphen[1])], ['<=', need(hyphen[2])]];
    return set.split(/\s+/).map((c) => {
      const m = /^(<=|>=|<|>|=)?(.*)$/.exec(c);
      return [m[1] ?? '=', need(m[2])];
    });
  });
}

/** Whether a release (no prerelease identifiers) lies in the range. */
export function satisfies(version, range) {
  const hold = { '<': (c) => c < 0, '<=': (c) => c <= 0, '>': (c) => c > 0, '>=': (c) => c >= 0, '=': (c) => c === 0 };
  return parseRange(range).some((set) => set.every(([op, v]) => hold[op](compare(version, v))));
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const days = (from, to) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY;

/** .github/audit/accepted.json read and checked for shape: a list of entries, each exactly
 *  { advisory, package, severity, paths, reason, expires }. Throws on anything else. A route is
 *  package names joined by " > ", each the name the package before it declares: its last hop is
 *  the package, or the alias a dependent installs it under; check() holds where it ends. */
export function readAccepted(text) {
  let list;
  try {
    list = JSON.parse(text);
  } catch (error) {
    throw new Error(`${ACCEPTED} is not JSON: ${error.message}`);
  }
  if (!Array.isArray(list)) throw new Error(`${ACCEPTED} is a list of entries`);
  const seen = new Set();
  return list.map((entry, i) => {
    const where = `${ACCEPTED}, entry ${i + 1}`;
    const fail = (why) => {
      throw new Error(`${where}: ${why}`);
    };
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail('an entry is an object');
    const keys = Object.keys(entry);
    if (keys.length !== FIELDS.length || !FIELDS.every((k) => Object.hasOwn(entry, k))) fail(`an entry has exactly ${FIELDS.join(', ')}`);
    const { advisory, package: name, severity, paths, reason, expires } = entry;
    if (typeof advisory !== 'string' || !GHSA.test(advisory)) fail('advisory is a GitHub advisory id (GHSA-xxxx-xxxx-xxxx)');
    if (typeof name !== 'string' || !NAME.test(name)) fail('package is an npm package name');
    if (typeof severity !== 'string' || !Object.hasOwn(RANK, severity)) fail(`severity is the one npm rated it when it was accepted: ${Object.keys(RANK).join(' or ')}`);
    if (!Array.isArray(paths) || paths.length === 0) fail('paths lists at least one route');
    for (const path of paths) {
      const hops = typeof path === 'string' ? path.split(' > ') : [];
      if (hops.length === 0 || !hops.every((hop) => NAME.test(hop)) || hops.join(' > ') !== path) fail(`a route is package names joined by " > ": ${JSON.stringify(path)}`);
      if (new Set(hops).size !== hops.length) fail(`a route names a package once: ${path}`);
    }
    if (new Set(paths).size !== paths.length) fail('each route is listed once');
    if (typeof reason !== 'string' || reason.trim() === '') fail('reason says why the advisory is accepted');
    if (!isDate(expires)) fail('expires is a date, YYYY-MM-DD');
    if (seen.has(`${advisory} ${name}`)) fail(`${advisory} for ${name} is accepted once`);
    seen.add(`${advisory} ${name}`);
    return { advisory, package: name, severity, paths: [...paths], reason, expires };
  });
}

/** Every advisory in an npm audit report (auditReportVersion 2), once per advisory and package. */
export function advisories(report) {
  if (report === null || typeof report !== 'object' || report.auditReportVersion !== 2 || report.vulnerabilities === null || typeof report.vulnerabilities !== 'object') {
    throw new Error('npm audit did not answer with a report this script reads (auditReportVersion 2)');
  }
  const out = new Map();
  for (const [name, vuln] of Object.entries(report.vulnerabilities)) {
    if (vuln === null || typeof vuln !== 'object' || !Array.isArray(vuln.via)) throw new Error(`npm audit's entry for ${name} has no via list`);
    for (const via of vuln.via) {
      if (typeof via === 'string') continue;
      if (via === null || typeof via !== 'object') throw new Error(`npm audit's entry for ${name} has a via this script does not read`);
      const url = typeof via.url === 'string' ? via.url : '';
      const id = /\/(GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})$/.exec(url)?.[1] ?? `npm advisory ${String(via.source)}`;
      const pkg = typeof via.name === 'string' ? via.name : name;
      out.set(`${id} ${pkg}`, { id, package: pkg, severity: String(via.severity), range: via.range, title: String(via.title ?? ''), url });
    }
  }
  return [...out.values()];
}

/** The lockfile (lockfileVersion 2 or 3) as a graph of production dependencies. `starts(name)`
 *  is where a direct dependency of the root or of a workspace is installed; `next(loc, name)` is
 *  where the package at `loc` loads a dependency it declares (dependencies, optional or peer),
 *  found as Node finds it and following workspace links, or null. devDependencies are not edges:
 *  the lockfile records them for the root and the workspaces only, and those are left out. */
export function lockGraph(lock) {
  const packages = lock?.packages;
  if (packages === null || typeof packages !== 'object' || !Object.hasOwn(packages, '')) throw new Error('the lockfile has no packages map (lockfileVersion 2 or 3)');
  const at = (loc) => (Object.hasOwn(packages, loc) ? packages[loc] : undefined);
  const real = (loc) => (at(loc)?.link === true && typeof at(loc).resolved === 'string' ? at(loc).resolved : loc);
  const declared = (loc) => {
    const p = at(loc) ?? {};
    return new Set([p.dependencies, p.optionalDependencies, p.peerDependencies].flatMap((d) => (d !== null && typeof d === 'object' ? Object.keys(d) : [])));
  };
  const find = (from, name) => {
    for (let dir = from; ; ) {
      const loc = `${dir === '' ? '' : `${dir}/`}node_modules/${name}`;
      if (at(loc) !== undefined) return real(loc);
      if (dir === '') return null;
      const cut = dir.lastIndexOf('/node_modules/');
      dir = cut === -1 ? '' : dir.slice(0, cut);
    }
  };
  const tops = Object.keys(packages).filter((loc) => !loc.split('/').includes('node_modules'));
  return {
    starts: (name) => [...new Set(tops.filter((t) => declared(t).has(name)).map((t) => find(t, name)).filter((loc) => loc !== null))],
    next: (loc, name) => (declared(loc).has(name) ? find(loc, name) : null),
    edges: (loc) => [...declared(loc)],
    roots: () => [...new Set(tops.flatMap((t) => [...declared(t)]))],
  };
}

/** Where a route `a > b > ... > pkg` ends in the lockfile: the locations it can reach, empty when
 *  a hop is not a production dependency of the one before it. */
export function follow(graph, path) {
  const [head, ...rest] = path.split(' > ');
  let here = graph.starts(head);
  for (const hop of rest) here = [...new Set(here.map((loc) => graph.next(loc, hop)).filter((loc) => loc !== null))];
  return here;
}

/** The shortest route to each of `targets` from the direct dependencies `heads` (every one, by
 *  default), as text, or none for one nothing reaches. */
export function shortest(graph, targets, heads = graph.roots()) {
  const prev = new Map();
  const queue = [];
  for (const name of heads) {
    for (const loc of graph.starts(name)) {
      if (!prev.has(loc)) {
        prev.set(loc, { from: null, name });
        queue.push(loc);
      }
    }
  }
  for (let i = 0; i < queue.length; i += 1) {
    for (const name of graph.edges(queue[i])) {
      const loc = graph.next(queue[i], name);
      if (loc !== null && !prev.has(loc)) {
        prev.set(loc, { from: queue[i], name });
        queue.push(loc);
      }
    }
  }
  return targets.flatMap((target) => {
    if (!prev.has(target)) return [];
    const names = [];
    for (let loc = target; loc !== null; loc = prev.get(loc).from) names.unshift(prev.get(loc).name);
    return [names.join(' > ')];
  });
}

/** The copies of the package npm reports, as lockfile locations. Throws when there are none. */
function copies(report, pkg) {
  const nodes = report.vulnerabilities[pkg]?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.some((n) => typeof n !== 'string')) throw new Error(`npm audit names no installed copy of ${pkg}`);
  return nodes;
}

/** The releases of the package that lie outside the advisory's range and are newer than a copy
 *  the lockfile installs: `fix`, the lowest in that copy's major (one its dependents can take),
 *  and `beyond`, the lowest on a newer major only; each as text, or null. Throws when it cannot
 *  tell. */
export function fixFor(report, advisory, lock, published) {
  const pkg = advisory.package;
  parseRange(advisory.range);
  const nodes = copies(report, pkg);
  const installed = nodes.map((node) => parseVersion(lock?.packages?.[node]?.version));
  if (installed.some((v) => v === null)) throw new Error(`the lockfile gives no version for every installed copy of ${pkg} (${nodes.join(', ')})`);
  const releases = published[pkg];
  if (!Array.isArray(releases) || releases.length === 0 || releases.some((r) => typeof r !== 'string')) throw new Error(`the releases of ${pkg} could not be read`);
  const outside = releases
    .map((text) => [text, parseVersion(text)])
    .filter(([, v]) => v !== null && v[3].length === 0 && installed.some((c) => compare(v, c) > 0) && !satisfies(v, advisory.range))
    .sort((a, b) => compare(a[1], b[1]));
  const fix = outside.find(([, v]) => installed.some((c) => compare(v, c) > 0 && sameMajor(v, c)));
  return { fix: fix ? fix[0] : null, beyond: outside.length > 0 && !fix ? outside[0][0] : null };
}

/** The gate: every advisory at high or above accepted, every acceptance still standing. Returns
 *  the problems (the job fails on any) and a line for each acceptance that holds. */
export function check({ report, accepted, today, lock, published }) {
  if (!isDate(today)) throw new Error(`today is a date, YYYY-MM-DD: ${today}`);
  const graph = lockGraph(lock);
  const problems = [];
  const notes = [];
  const used = new Set();
  for (const a of advisories(report).filter((x) => !BELOW.has(x.severity))) {
    const label = `${a.package} ${a.id} (${a.severity}, ${a.range})`;
    const entry = accepted.find((e) => e.advisory === a.id && e.package === a.package);
    if (!entry) {
      let routes = [];
      try {
        routes = shortest(graph, copies(report, a.package));
      } catch {
        routes = [];
      }
      problems.push(`${label}: not accepted in ${ACCEPTED}. ${a.title} ${a.url}. It arrives by ${routes.join('; ') || 'no route the lockfile shows'}`);
      continue;
    }
    used.add(entry);
    const before = problems.length;
    let beyond = null;
    const left = days(today, entry.expires);
    if (left <= 0) problems.push(`${label}: its acceptance expired on ${entry.expires}`);
    else if (left > MAX_DAYS) problems.push(`${label}: its acceptance runs to ${entry.expires}, more than ${MAX_DAYS} days away`);
    if (!Object.hasOwn(RANK, a.severity) || RANK[a.severity] > RANK[entry.severity]) problems.push(`${label}: npm now rates it ${a.severity}, above the ${entry.severity} it was accepted at: review the reason, then the entry`);
    try {
      const nodes = copies(report, a.package);
      const reached = new Set();
      for (const path of entry.paths) {
        const ends = follow(graph, path).filter((loc) => nodes.includes(loc));
        if (ends.length === 0) problems.push(`${label}: "${path}" is not a chain of production dependencies in the lockfile that ends at a copy npm reports`);
        for (const loc of ends) reached.add(loc);
      }
      for (const loc of nodes.filter((n) => !reached.has(n))) problems.push(`${label}: no route the entry names reaches the copy at ${loc}${shortest(graph, [loc]).map((r) => ` (it arrives by ${r})`).join('')}`);
      // The reason was written for the routes named: a direct dependency that reaches a copy by
      // another way is one it was not written for.
      const heads = new Set(entry.paths.map((path) => path.split(' > ')[0]));
      for (const head of graph.roots().filter((r) => !heads.has(r))) {
        const [route] = shortest(graph, nodes, [head]).sort((x, y) => x.split(' > ').length - y.split(' > ').length);
        if (route !== undefined) problems.push(`${label}: ${head} also reaches it, by ${route}, and no route the entry names starts there: check the reason holds for it, then add the route`);
      }
      const releases = fixFor(report, a, lock, published);
      if (releases.fix !== null) problems.push(`${label}: ${a.package} ${releases.fix} lies outside the advisory's range: take the fix, then remove the entry`);
      beyond = releases.beyond;
    } catch (error) {
      problems.push(`${label}: ${error.message}`);
    }
    if (problems.length === before) {
      notes.push(`${label}: accepted until ${entry.expires}, arriving by ${entry.paths.join('; ')}: ${entry.reason}`);
      if (beyond !== null) notes.push(`${label}: ${a.package} ${beyond} lies outside the range, on a major no installed copy's dependents take; the entry holds until it expires`);
    }
  }
  for (const e of accepted) if (!used.has(e)) problems.push(`${ACCEPTED} accepts ${e.advisory} for ${e.package}, which npm audit does not report at high or above: remove the entry`);
  return { problems, notes };
}

/** One run of the gate in `root`, with `npm(args)` answering as spawnSync does ({ status, stdout,
 *  stderr }), `today` as YYYY-MM-DD, and `log`/`error` for the output. Returns the exit code: 0
 *  when nothing at high or above is unaccepted and every acceptance holds, 1 otherwise. */
export function run({ root, npm, today, log, error }) {
  const stop = (why) => {
    error(`audit: ${why}`);
    return 1;
  };
  if (!existsSync(join(root, 'package-lock.json'))) return stop('no package-lock.json here, so nothing to audit');
  let accepted;
  try {
    accepted = existsSync(join(root, ACCEPTED)) ? readAccepted(readFileSync(join(root, ACCEPTED), 'utf8')) : [];
  } catch (e) {
    return stop(e.message);
  }
  const audit = npm(['audit', '--omit=dev', '--json']);
  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    return stop(`npm audit did not answer with JSON (exit ${audit.status}): ${String(audit.stderr).trim()}`);
  }
  if (report !== null && typeof report === 'object' && Object.hasOwn(report, 'error')) return stop(`npm audit failed: ${JSON.stringify(report.error)}`);
  const published = {};
  for (const name of new Set(accepted.map((e) => e.package))) {
    const view = npm(['view', name, 'versions', '--json']);
    let versions = null;
    try {
      versions = view.status === 0 ? JSON.parse(view.stdout) : null;
    } catch {
      versions = null;
    }
    published[name] = typeof versions === 'string' ? [versions] : versions;
  }
  let result;
  try {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    result = check({ report, accepted, today, lock, published });
  } catch (e) {
    return stop(e.message);
  }
  log(`npm audit --omit=dev: ${JSON.stringify(report.metadata?.vulnerabilities ?? {})}`);
  for (const note of result.notes) log(`accepted: ${note}`);
  for (const problem of result.problems) error(`audit: ${problem}`);
  if (result.problems.length > 0) return stop(`${result.problems.length} problem(s); CONVENTIONS.md, "CI", says what an entry in ${ACCEPTED} needs`);
  log('audit: nothing at high or above that is not accepted');
  return 0;
}

// Run as `node .github/audit/npm-audit.mjs`, not when imported. Both sides are real paths, since
// Node resolves the main module's links and a checkout under a linked folder would otherwise
// skip run() and pass having audited nothing.
const proc = globalThis.process;
const entry = proc.argv[1];
if (entry !== undefined && existsSync(entry) && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  const root = proc.cwd();
  const out = globalThis.console;
  proc.exit(
    run({
      root,
      npm: (args) => spawnSync('npm', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }),
      today: new Date().toISOString().slice(0, 10),
      log: (line) => out.log(line),
      error: (line) => out.error(line),
    }),
  );
}
