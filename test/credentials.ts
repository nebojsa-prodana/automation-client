import { GitHubRepoRef } from "../lib/operations/common/GitHubRepoRef";

export const GitHubToken: string = "NOT_A_LEGIT_TOKEN";

export const Creds = { token: GitHubToken };

export const RepoThatExists = new GitHubRepoRef("atomist-travisorg", "this-repository-exists");

function visibility(): "public" | "private" {
    const vis = process.env.GITHUB_VISIBILITY || "private";
    if (vis === "public" || vis === "private") {
        return vis;
    }
    throw new Error(`GITHUB_VISIBILITY must be public or private. yours is '${vis}'`);
}

export const TestRepositoryVisibility = visibility();
