import { Octokit } from 'octokit';
import { createAppAuth } from '@octokit/auth-app';
import dotenv from 'dotenv';
dotenv.config();

async function getInstallations() {
    const appOctokit = new Octokit({
        authStrategy: createAppAuth,
        auth: {
            appId: process.env.GITHUB_APP_ID,
            privateKey: process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }
    });

    try {
        const { data: installations } = await appOctokit.rest.apps.listInstallations();
        console.log("=== APP INSTALLATIONS ===");
        installations.forEach(inst => {
            console.log(`Account: ${inst.account.login} | ID: ${inst.id}`);
        });
    } catch (e) {
        console.error("Error:", e.message);
    }
}

getInstallations();
