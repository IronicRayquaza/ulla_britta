import { ToolRegistry } from '../registry.mjs';
import { registerAll } from './common.mjs';

import repos from './repos.mjs';
import files from './files.mjs';
import git from './git.mjs';
import issues from './issues.mjs';
import pulls from './pulls.mjs';
import actions from './actions.mjs';
import releases from './releases.mjs';
import users from './users.mjs';
import insights from './insights.mjs';

/**
 * The agent's capabilities.
 *
 * Every tool here does what its description says. Tools that only produced an LLM
 * opinion dressed as a verified result (dependency "audits" recalled from training
 * data, health "scores" from a fixed template, conflict resolution that never read
 * a file) were removed rather than kept with softer wording.
 *
 * The surface used to stop at repositories and pull requests, which is why the
 * agent had to answer "my current tools do not allow me to access user profile
 * information" and could not create a plain repository, read a CI log, open an
 * issue, cut a release or trigger a workflow. It now covers the GitHub domains a
 * person actually works in. docs/AGENT_CAPABILITIES.md is the map, and is kept in
 * step with this file.
 *
 * Grouping is by GitHub domain, one module each, so a tool's schema, its handler
 * and its neighbours stay together.
 */
export const MODULES = {
    repositories: repos,
    files,
    git,
    issues,
    pullRequests: pulls,
    actions,
    releases,
    users,
    insights
};

export function buildRegistry() {
    const registry = new ToolRegistry();
    for (const tools of Object.values(MODULES)) {
        registerAll(registry, tools);
    }
    return registry;
}

/** The capability map, for documentation and for the dashboard. */
export function capabilityMap() {
    return Object.entries(MODULES).map(([domain, tools]) => ({
        domain,
        count: tools.length,
        tools: tools.map(t => ({
            name: t.name,
            description: t.description,
            destructive: Boolean(t.destructive),
            sideEffecting: Boolean(t.sideEffecting),
            parameters: Object.keys(t.parameters?.properties || {}),
            required: t.parameters?.required || []
        }))
    }));
}

export default buildRegistry;
