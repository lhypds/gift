import styles from "./link.module.css";

// A repository name, linked to GitHub when the server could resolve a URL for
// it (see repositoryLink/repositoryHooksLink in server.js), plain text otherwise.
export default function RepoLink({ repo }) {
  if (!repo.href) return repo.label;
  return (
    <a
      className={styles.repoLink}
      href={repo.href}
      target="_blank"
      rel="noopener noreferrer"
      title={repo.title}
      onClick={(event) => event.stopPropagation()}
    >
      {repo.label}
    </a>
  );
}
