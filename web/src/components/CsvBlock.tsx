// A generated HotCRP assignment CSV: the first lines shown, the whole file
// copyable. The chair pastes or uploads it in HotCRP and checks the preview
// there; nothing is applied from the dashboard.

import { useState } from "react";

const SHOWN = 200;

export function CsvBlock({ csv, testId }: { csv: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const lines = csv.split("\n").filter((l) => l !== "");
  const shown = lines.slice(0, SHOWN + 1).join("\n");
  return (
    <div>
      <button
        type="button"
        className="btn"
        onClick={() => {
          void navigator.clipboard?.writeText(csv).then(() => setCopied(true));
        }}
      >
        {copied ? "Copied" : `Copy CSV (${lines.length - 1} lines)`}
      </button>
      <pre className="csv" data-testid={testId}>
        {shown}
        {lines.length > SHOWN + 1 ? `\n… ${lines.length - 1 - SHOWN} more lines (copy the CSV for all of them)` : ""}
      </pre>
    </div>
  );
}
