
import { MappedParameter, MappedParameters, Parameter, Secret, Secrets } from "../../decorators";
import { GitHubNameRegExp } from "../common/params/gitHubPatterns";
import { RepoId } from "../common/RepoId";

/**
 * Parameters common to all generators that create new repositories
 */
export class NewRepoCreationParameters implements RepoId {

    @Secret(Secrets.userToken(["repo", "user"]))
    public githubToken;

    @MappedParameter(MappedParameters.GitHubOwner)
    public owner: string;

    @Parameter({
        pattern: GitHubNameRegExp.pattern,
        displayName: "Target Repository Name",
        description: "name of the target repository",
        validInput: GitHubNameRegExp.validInput,
        minLength: 1,
        maxLength: 100,
        required: true,
        order: 1,
    })
    public repo: string;

    @Parameter({
        displayName: "Project Description",
        description: "short descriptive text describing the new project",
        validInput: "free text",
        minLength: 1,
        maxLength: 100,
        required: false,
    })
    public description: string = "my new project";

    @Parameter({
        displayName: "Repository Visibility",
        description: "visibility of the new repository (public or private; defaults to public)",
        pattern: /^(public|private)$/,
        validInput: "public or private",
        minLength: 6,
        maxLength: 7,
        required: false,
    })
    public visibility: "public" | "private" = "public";

}
