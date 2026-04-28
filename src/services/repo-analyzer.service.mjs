import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';

const execAsync = promisify(exec);

/**
 * Repository Analyzer
 * Provides deep architectural context by cloning and scanning repos.
 */
class RepositoryAnalyzer {
    constructor() {
        this.baseTmpPath = '/tmp/ulla_work';
    }

    /**
     * Shallow clone for rapid analysis (Supports Private Repos).
     */
    async cloneRepo(owner, repo, branch = 'main', token = null) {
        const repoPath = path.join(this.baseTmpPath, `${owner}_${repo}`);
        await execAsync(`mkdir -p ${path.dirname(repoPath)}`);
        
        // Remove old if exists
        await execAsync(`rm -rf ${repoPath}`).catch(() => {});

        try {
            // If we have a token, inject it for private repo access
            const remoteUrl = token 
                ? `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
                : `https://github.com/${owner}/${repo}.git`;

            await execAsync(
                `git clone --depth 1 --branch ${branch} ${remoteUrl} ${repoPath}`,
                { timeout: 30000 }
            );
            return repoPath;
        } catch (e) {
            console.error(`❌ Clone failed: ${e.message}`);
            return null;
        }
    }

    /**
     * Detect tech stack (Frameworks, Styles, Languages).
     */
    async detectTechStack(repoPath) {
        try {
            const pkgPath = path.join(repoPath, 'package.json');
            const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };

            const stack = {
                framework: deps.next ? 'Next.js' : deps.react ? 'React' : 'Node.js',
                styling: deps.tailwindcss ? 'Tailwind' : 'CSS',
                isTypeScript: !!(deps.typescript || await fs.access(path.join(repoPath, 'tsconfig.json')).then(() => true).catch(() => false))
            };
            return stack;
        } catch (e) {
            return { framework: 'Unknown', styling: 'Unknown', isTypeScript: false };
        }
    }

    /**
     * Build a bird's-eye view of the file structure.
     */
    async getStructure(repoPath) {
        try {
            const files = await glob('**/*.{js,jsx,ts,tsx,json}', {
                cwd: repoPath,
                ignore: ['node_modules/**', '.git/**', '.next/**', 'dist/**']
            });
            return files.join('\n');
        } catch (e) {
            return "Could not map structure.";
        }
    }

    /**
     * Read a specific file from the cloned repo.
     */
    async getFileContent(filePath) {
        return await fs.readFile(filePath, 'utf8');
    }

    async cleanup(repoPath) {
        await execAsync(`rm -rf ${repoPath}`).catch(() => {});
    }
}

export default new RepositoryAnalyzer();
