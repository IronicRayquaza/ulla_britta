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
     * Shallow clone for rapid analysis.
     */
    async cloneRepo(owner, repo, branch = 'main') {
        const repoPath = path.join(this.baseTmpPath, `${owner}_${repo}`);
        await execAsync(`mkdir -p ${path.dirname(repoPath)}`);
        
        // Remove old if exists
        await execAsync(`rm -rf ${repoPath}`).catch(() => {});

        try {
            await execAsync(
                `git clone --depth 1 --branch ${branch} https://github.com/${owner}/${repo}.git ${repoPath}`,
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

    async cleanup(repoPath) {
        await execAsync(`rm -rf ${repoPath}`).catch(() => {});
    }
}

export default new RepositoryAnalyzer();
