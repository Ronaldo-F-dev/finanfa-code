export function ModelSelector({
  models,
  model,
  onChange,
  disabled,
}: {
  models: string[];
  model: string;
  onChange: (model: string) => void;
  disabled?: boolean;
}) {
  return (
    <select className="model-select" value={model} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {models.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}
