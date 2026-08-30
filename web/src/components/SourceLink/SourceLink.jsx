import styles from "./link.module.css";

// What an event happened to: a repository, a URL, a file path, a snatch of
// copied text. The server resolves a link for the ones that have somewhere to
// go (see repositoryLink in triggers/github/serve.js, and the website trigger's
// own); everything else is a label, and renders as plain text.
export default function SourceLink({ source }) {
  if (!source) return null;
  if (!source.href) return source.label;
  return (
    <a
      className={styles.repoLink}
      href={source.href}
      target="_blank"
      rel="noopener noreferrer"
      title={source.title}
      onClick={(event) => event.stopPropagation()}
    >
      {source.label}
    </a>
  );
}
