import { fileIconSrcForDisplay } from "./fileIconSrc";
import styles from "./FileNameWithIcon.module.css";

type Props = {
  text: string;
  className?: string;
};

/** Renders a small language/file icon before text when the value looks like a file path or name. */
export default function FileNameWithIcon({ text, className }: Props) {
  const src = fileIconSrcForDisplay(text);
  if (!src) return <span className={className}>{text}</span>;
  return (
    <span className={`${styles.fileNameRow} ${className ?? ""}`}>
      <img src={src} alt="" className={styles.fileNameIcon} width={18} height={18} />
      <span>{text}</span>
    </span>
  );
}
