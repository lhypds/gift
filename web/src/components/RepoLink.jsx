// A repository name, linked to GitHub when the server could resolve a URL for
// it (see repositoryLink/repositoryHooksLink in server.js), plain text otherwise.
export default function RepoLink({ repo }) {
  if (!repo.href) return repo.label;
  return (
    <a className="repo-link" href={repo.href} target="_blank" rel="noopener noreferrer" title={repo.title}>
      {repo.label}
    </a>
  );
}
