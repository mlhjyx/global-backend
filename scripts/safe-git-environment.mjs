// Environment for spawning git against an explicit repository.
//
// Git exports GIT_DIR, GIT_PREFIX, GIT_CONFIG_PARAMETERS, ... to hooks and to
// `git rebase -x`. A child git that inherits them ignores its cwd and operates
// on the outer repository instead: fixture `git init`/`git config`/`git commit`
// then rewrite that repository's config and branches. Strip every GIT_*
// override and disable credential prompts.
export function createSafeGitEnvironment(environment = process.env) {
  const safeEnvironment = Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith("GIT_")),
  );
  return {
    ...safeEnvironment,
    GIT_TERMINAL_PROMPT: "0",
  };
}
