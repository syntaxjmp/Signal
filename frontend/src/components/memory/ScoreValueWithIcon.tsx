import { scoreIconSrc } from "./scoreFieldIcon";
import styles from "./ScoreValueWithIcon.module.css";

type Props = {
  value: string;
  /** e.g. from a sibling "Severity" field */
  severityHint?: string;
};

/** Renders check / warning icons for numeric score values; plain text if not parseable as a number. */
export default function ScoreValueWithIcon({ value, severityHint }: Props) {
  const src = scoreIconSrc(value, severityHint);
  if (!src) return <span>{value}</span>;
  return (
    <span className={styles.scoreRow}>
      <img src={src} alt="" className={styles.scoreIcon} width={18} height={18} />
      <span>{value}</span>
    </span>
  );
}
