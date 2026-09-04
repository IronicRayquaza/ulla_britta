/**
 * Dependency facts, from the npm registry.
 *
 * The previous implementation asked the model which packages were "notoriously
 * outdated". That answer is recalled from training data, frozen at the model's
 * cutoff, and unverifiable — it read like an audit while being a guess. This asks
 * the registry and reports what it says.
 */

const REGISTRY = 'https://registry.npmjs.org';
const ADVISORY_API = 'https://api.osv.dev/v1/querybatch';

/** Strips a semver range down to the version it points at. */
function baseVersion(range) {
    if (typeof range !== 'string') return null;
    const m = range.match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? { major: +m[1], minor: +m[2], patch: +m[3], raw: m[0] } : null;
}

function compare(current, latest) {
    if (!current || !latest) return 'unknown';
    if (latest.major > current.major) return 'major';
    if (latest.major === current.major && latest.minor > current.minor) return 'minor';
    if (latest.major === current.major && latest.minor === current.minor && latest.patch > current.patch) return 'patch';
    return 'current';
}

/**
 * Latest published version of one package, or null if the registry has no answer.
 *
 * The package name is used unencoded: the registry serves scoped packages at
 * /@scope/name, and percent-encoding the slash returns a 404. The abbreviated
 * metadata Accept header is not valid on /latest and gets a 406, so it is only
 * sent with the document request.
 */
async function latestVersion(name) {
    try {
        const res = await fetch(`${REGISTRY}/${name}/latest`);
        if (!res.ok) return null;
        const data = await res.json();
        return data.version || null;
    } catch {
        return null;
    }
}

/**
 * Known vulnerabilities from OSV. Returns an empty map if the service is
 * unreachable — an unavailable advisory feed is reported as unknown, never as
 * "no vulnerabilities found".
 */
async function knownVulnerabilities(packages) {
    try {
        const res = await fetch(ADVISORY_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                queries: packages.map(p => ({
                    package: { name: p.name, ecosystem: 'npm' },
                    version: p.version
                }))
            })
        });
        if (!res.ok) return null;

        const data = await res.json();
        const out = new Map();
        (data.results || []).forEach((result, i) => {
            const vulns = result?.vulns || [];
            if (vulns.length) out.set(packages[i].name, vulns.map(v => v.id));
        });
        return out;
    } catch {
        return null;
    }
}

/**
 * Compares a package.json against the registry.
 *
 * @returns {{ checked, outdated, vulnerable, advisoriesAvailable, unresolved }}
 */
export async function checkDependencies(packageJsonContent) {
    let pkg;
    try {
        pkg = JSON.parse(packageJsonContent);
    } catch (e) {
        return { error: `package.json is not valid JSON: ${e.message}` };
    }

    const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const names = Object.keys(declared);

    if (names.length === 0) {
        return { checked: 0, outdated: [], vulnerable: [], advisoriesAvailable: true, unresolved: [] };
    }

    // Bounded concurrency: enough to be quick, not enough to look like abuse.
    const results = [];
    const queue = [...names];
    const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
        while (queue.length) {
            const name = queue.shift();
            const latest = await latestVersion(name);
            results.push({ name, declared: declared[name], latest });
        }
    });
    await Promise.all(workers);

    const unresolved = results.filter(r => !r.latest).map(r => r.name);

    const compared = results
        .filter(r => r.latest)
        .map(r => {
            const current = baseVersion(r.declared);
            const latest = baseVersion(r.latest);
            return {
                name: r.name,
                declared: r.declared,
                latest: r.latest,
                drift: compare(current, latest)
            };
        });

    const outdated = compared
        .filter(r => ['major', 'minor', 'patch'].includes(r.drift))
        .sort((a, b) => ({ major: 0, minor: 1, patch: 2 }[a.drift] - { major: 0, minor: 1, patch: 2 }[b.drift]));

    const vulns = await knownVulnerabilities(
        compared
            .map(r => ({ name: r.name, version: baseVersion(r.declared)?.raw }))
            .filter(p => p.version)
    );

    return {
        checked: results.length,
        outdated,
        upToDate: compared.filter(r => r.drift === 'current').length,
        // Distinguishes "we checked and found none" from "we could not check".
        advisoriesAvailable: vulns !== null,
        vulnerable: vulns ? [...vulns.entries()].map(([name, ids]) => ({ name, advisories: ids })) : [],
        unresolved,
        source: 'registry.npmjs.org (versions), osv.dev (advisories)'
    };
}

/** Human-readable summary of a checkDependencies result. */
export function formatDependencyReport(repoName, result) {
    if (result.error) return `Could not check dependencies for ${repoName}: ${result.error}`;

    const lines = [`### Dependencies: ${repoName}`, '', `Checked ${result.checked} packages against the npm registry.`];

    const resolved = result.checked - (result.unresolved?.length || 0);

    // Saying "everything is up to date" when nothing could be looked up would be a
    // clean-looking report of no information.
    if (resolved === 0) {
        lines.push('', '**No packages could be checked** — the registry did not resolve any of them, '
            + 'so nothing here says whether they are current.');
    } else if (result.outdated.length === 0) {
        lines.push('', `All ${resolved} resolved packages are on their latest published version.`);
    } else {
        const major = result.outdated.filter(o => o.drift === 'major');
        lines.push('', `**${result.outdated.length} outdated** (${major.length} with a major version behind):`, '');
        for (const o of result.outdated.slice(0, 25)) {
            lines.push(`- \`${o.name}\` ${o.declared} → ${o.latest} (${o.drift})`);
        }
        if (result.outdated.length > 25) lines.push(`- …and ${result.outdated.length - 25} more`);
    }

    if (!result.advisoriesAvailable) {
        lines.push('', '_The advisory database could not be reached, so vulnerabilities were not checked._');
    } else if (result.vulnerable.length) {
        lines.push('', `**${result.vulnerable.length} package(s) with known advisories:**`, '');
        for (const v of result.vulnerable) {
            const shown = v.advisories.slice(0, 6).join(', ');
            const more = v.advisories.length > 6 ? ` (+${v.advisories.length - 6} more)` : '';
            lines.push(`- \`${v.name}\`: ${shown}${more}`);
        }
        lines.push('',
            '_Advisories are matched against the lowest version each range allows, which is '
            + 'what a fresh install without a lockfile would resolve to. An installed lockfile '
            + 'may already be on a patched version — check the lockfile before acting._');
    } else {
        lines.push('', 'No known advisories for the lowest version each declared range allows.');
    }

    if (result.unresolved?.length) {
        lines.push('', `_Not found on the registry (private or renamed): ${result.unresolved.join(', ')}._`);
    }

    return lines.join('\n');
}
