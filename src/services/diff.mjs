/**
 * Unified-diff parsing.
 *
 * GitHub only accepts a review comment anchored to a line that actually appears in
 * the pull request's diff; anything else is rejected with a 422 and the whole
 * review is lost. So we parse the patch, learn which lines can be commented on,
 * and drop the rest into the review body rather than letting the call fail.
 */

/**
 * Line numbers in the new version of a file that the patch touches.
 * These are the only lines a RIGHT-side review comment may target.
 *
 * @param {string} patch - The `patch` field GitHub returns per file.
 * @returns {{ commentable: Set<number>, added: Set<number> }}
 */
export function commentableLines(patch) {
    const commentable = new Set();
    const added = new Set();
    if (!patch) return { commentable, added };

    let newLine = 0;

    for (const line of patch.split('\n')) {
        const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
            newLine = Number(hunk[1]);
            continue;
        }

        if (line.startsWith('+')) {
            commentable.add(newLine);
            added.add(newLine);
            newLine++;
        } else if (line.startsWith('-')) {
            // Removed lines exist only on the LEFT side; they advance nothing.
        } else if (line.startsWith('\\')) {
            // "\ No newline at end of file"
        } else {
            // Context lines are commentable and advance the counter.
            commentable.add(newLine);
            newLine++;
        }
    }

    return { commentable, added };
}

/**
 * Numbers the added lines of a patch so a model can cite real line numbers instead
 * of guessing at them.
 */
export function annotatePatch(patch) {
    if (!patch) return '';
    let newLine = 0;
    const out = [];

    for (const line of patch.split('\n')) {
        const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
            newLine = Number(hunk[1]);
            out.push(line);
            continue;
        }
        if (line.startsWith('+')) {
            out.push(`${String(newLine).padStart(5)} ${line}`);
            newLine++;
        } else if (line.startsWith('-')) {
            out.push(`      ${line}`);
        } else if (line.startsWith('\\')) {
            out.push(line);
        } else {
            out.push(`${String(newLine).padStart(5)} ${line}`);
            newLine++;
        }
    }
    return out.join('\n');
}

/**
 * Splits a file list into what fits in a prompt and what does not, so a large PR
 * degrades into "reviewed these N files" rather than a silent truncation halfway
 * through a hunk.
 *
 * @returns {{ included: object[], omitted: object[], text: string }}
 */
export function buildDiffContext(files, budgetChars = 60_000) {
    const included = [];
    const omitted = [];
    let used = 0;

    // Skip generated files: they are large, and nobody wants a review of a lockfile.
    const isNoise = (f) => /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.min\.(js|css)|.*\.map)$/.test(f.filename)
        || f.filename.startsWith('dist/')
        || f.filename.startsWith('build/');

    for (const file of files) {
        if (isNoise(file) || !file.patch) {
            omitted.push({ filename: file.filename, reason: file.patch ? 'generated' : 'binary or too large' });
            continue;
        }

        const block = `\n--- ${file.filename} (+${file.additions} -${file.deletions}) ---\n${annotatePatch(file.patch)}\n`;
        if (used + block.length > budgetChars) {
            omitted.push({ filename: file.filename, reason: 'diff budget exhausted' });
            continue;
        }

        included.push(file);
        used += block.length;
    }

    const text = included
        .map(f => `\n--- ${f.filename} (+${f.additions} -${f.deletions}) ---\n${annotatePatch(f.patch)}\n`)
        .join('');

    return { included, omitted, text };
}
