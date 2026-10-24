import React, { useEffect, useState } from "react";
import { call } from "./api.ts";

const STEPS = ["Source", "Destination", "Mapping", "Review", "Execute"];

export function App() {
  const [state, setState] = useState({ loading: true, info: null, error: null, page: "onboarding" });
  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try {
      const settings = await call("settings.get");
      const info = await call("system.getInfo");
      setState({ loading: false, info, error: null, page: settings?.onboardingComplete ? "workspace" : "onboarding" });
    } catch (error) {
      setState({ loading: false, info: null, error: String(error?.message ?? error), page: "onboarding" });
    }
  }

  if (state.loading) return <div className="layout"><p>Starting SPOOL Console�</p></div>;
  if (state.error) return <div className="layout"><Panel title="Startup problem"><p>{state.error}</p></Panel></div>;

  return (
    <div className="layout">
      <header className="topbar">
        <span className="brand">SPOOL Console</span>
        <span className="release">engine {state.info?.engine?.release} � {String(state.info?.engine?.commitSha ?? "").slice(0, 7)}</span>
      </header>
      <Wizard />
    </div>
  );
}

function Wizard() {
  const [step, setStep] = useState(0);
  const [workspaces, setWorkspaces] = useState([]);
  const [workspaceId, setWorkspaceId] = useState(null);
  const [source, setSource] = useState(null);
  const [destination, setDestination] = useState(null);
  const [tables, setTables] = useState(null);
  const [tableChoice, setTableChoice] = useState(null);
  const [mapping, setMapping] = useState([]);
  const [migration, setMigration] = useState(null);
  const [dryRun, setDryRun] = useState(null);
  const [approval, setApproval] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { void listWorkspaces(); }, []);

  async function listWorkspaces() {
    const list = await call("workspace.list", {});
    setWorkspaces(list);
    if (list.length) setWorkspaceId(list[0].workspaceId);
  }

  async function chooseSource() {
    const path = await call("source.choose", {});
    if (!path) return;
    setBusy(true); setError(null);
    try {
      const profile = await call("source.inspect", { path });
      await call("settings.update", { supportConsent: false });
      setSource(profile);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  async function chooseDestination() {
    const path = await call("destination.choose", {});
    if (!path) return;
    setBusy(true); setError(null);
    try {
      const catalog = await call("destination.listTables", { path });
      setDestination(catalog);
      setTableChoice(null);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  async function pickTable(table) {
    if (!destination) return;
    setBusy(true); setError(null);
    try {
      const inspected = await call("destination.inspect", { path: destination.path, table: table.name });
      setTableChoice(inspected);
      const defaults = defaultMapping(source.headers, inspected.targetSchema);
      setMapping(defaults);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  async function createAndPlan() {
    setBusy(true); setError(null);
    try {
      const record = await call("migration.create", {
        workspaceId, name: `${source.name} -> ${tableChoice.table}`,
        sourceProfile: source,
        destination: { path: destination.path, table: tableChoice.table, targetContractId: tableChoice.targetContractId, targetSchema: tableChoice.targetSchema },
        mapping, mappingRevision: 1, planRevision: 1, batchSize: 1000
      });
      setMigration(record);
      const planned = await call("migration.plan", { migrationId: record.migrationId });
      const dry = await call("migration.dryRun", { migrationId: record.migrationId });
      setDryRun(dry);
      setStep(3);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  async function approveAndExecute() {
    setBusy(true); setError(null);
    try {
      const approved = await call("migration.approve", { migrationId: migration.migrationId });
      setApproval(approved);
      const runResult = await call("migration.execute", { migrationId: migration.migrationId });
      setResult(runResult);
      const receipt = await call("migration.receipt", { migrationId: migration.migrationId });
      setResult({ run: runResult, receipt });
      setStep(4);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <div>
      <ol className="steps">{STEPS.map((label, index) => (
        <li key={label} className={index === Math.min(Math.round(step), 4) ? "active" : index < step ? "done" : ""}>{label}</li>
      ))}</ol>
      <Panel title={STEPS[step]}>
        {error && <Banner error={error} />}
        {busy && <p>Working�</p>}
        {step === 0 && (
          <div>
            <p>Choose a UTF-8 CSV file. Sources are bounded by the qualified 256 MiB ceiling.</p>
            <Button onClick={chooseSource} disabled={busy}>Choose CSV�</Button>
            {source && <ProfileTable source={source} onNext={() => setStep(1)} />}
          </div>
        )}
        {step === 1 && source && (
          <div>
            <p>Choose an existing ordinary SQLite table as the target.</p>
            <Button onClick={chooseDestination} disabled={busy}>Choose SQLite database�</Button>
            {destination && <TableList catalog={destination} onPick={pickTable} />}
            {tableChoice && <TableProfile inspected={tableChoice} onNext={() => setStep(2)} />}
          </div>
        )}
        {step === 2 && tableChoice && (
          <div>
            <p>Map every required target column using allow-listed transformations.</p>
            <MappingEditor source={source} inspected={tableChoice} mapping={mapping} setMapping={setMapping} onNext={() => setStep(2.5)} />
          </div>
        )}
        {step === 2.5 && tableChoice && (
          <div>
            <MappingReview mapping={mapping} targetSchema={tableChoice.targetSchema} onBack={() => setStep(2)} onNext={createAndPlan} />
          </div>
        )}
        {step === 3 && dryRun && (
          <div>
            <DryRunSummary dryRun={dryRun} migration={migration} />
            <Button onClick={approveAndExecute} disabled={busy}>Approve and execute�</Button>
          </div>
        )}
        {step === 4 && result && (
          <ResultSummary result={result} migration={migration} onNext={() => setStep(0)} />
        )}
      </Panel>
    </div>
  );
}

function defaultMapping(sourceHeaders, targetSchema) {
  const normalise = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  const mapping = [];
  for (const field of targetSchema) {
    const matched = sourceHeaders.find(h => h === field.name) ?? sourceHeaders.find(h => normalise(h) === normalise(field.name));
    if (!matched) continue;
    const typeCast = { integer: "cast_number", number: "cast_number", boolean: "cast_boolean", date: "parse_date", local_datetime: "parse_local_datetime", string: "trim" }[field.type] ?? "trim";
    mapping.push({ target: field.name, expr: typeCast === "trim" ? { op: "trim", value: { op: "field", name: matched } } : { op: typeCast, value: { op: "field", name: matched } } });
  }
  return mapping;
}

function Panel({ title, children }) {
  return <section className="panel"><h2>{title}</h2>{children}</section>;
}

function Button({ children, onClick, disabled }) {
  return <button className="button" onClick={onClick} disabled={disabled}>{children}</button>;
}

function Banner({ error }) {
  return (
    <div className="banner error">
      <strong>{error?.code ?? "ERROR"}</strong>
      <p>{error?.message ?? String(error)}</p>
    </div>
  );
}

function ProfileTable({ source, onNext }) {
  return (
    <div>
      <table className="grid">
        <thead><tr><th>Column</th><th>Inferred type</th><th>Nullable</th><th>Sample distinct</th></tr></thead>
        <tbody>
          {source.columns.map(column => (
            <tr key={column.name}>
              <td>{column.name}</td><td>{column.inferredType}</td><td>{column.nullable ? "yes" : "no"}</td><td>{column.sampleDistinct}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>{source.rowCount} data rows � {source.sizeBytes} bytes � fingerprint {source.sourceFingerprint.slice(0, 19)}�</p>
      <Button onClick={onNext}>Next: Destination</Button>
    </div>
  );
}

function TableList({ catalog, onPick }) {
  if (!catalog.tables?.length) return <p>No ordinary tables found in this database.</p>;
  return (
    <table className="grid">
      <thead><tr><th>Table</th><th>Columns</th><th>Triggers</th><th>Eligible</th><th></th></tr></thead>
      <tbody>
        {catalog.tables.map(table => (
          <tr key={table.name}>
            <td>{table.name}</td><td>{table.columnCount}</td><td>{table.triggerCount}</td>
            <td>{table.eligible ? "yes" : "no (triggered/virtual)"}</td>
            <td><Button onClick={() => onPick(table)} disabled={!table.eligible}>Select</Button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TableProfile({ inspected, onNext }) {
  return (
    <div>
      <table className="grid">
        <thead><tr><th>Column</th><th>Declared type</th><th>Affinity</th><th>Not null</th><th>Suggested</th></tr></thead>
        <tbody>
          {inspected.columns.map(column => (
            <tr key={column.name}>
              <td>{column.name}</td><td>{column.declaredType}</td><td>{column.affinity}</td>
              <td>{column.notNull ? "yes" : "no"}</td><td>{column.suggestedType ?? "unsupported"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Target contract {inspected.targetContractId.slice(0, 19)}�</p>
      <Button onClick={onNext}>Next: Mapping</Button>
    </div>
  );
}

function MappingEditor({ source, inspected, mapping, setMapping, onNext }) {
  function update(index, field, value) {
    const next = mapping.map((entry, i) => {
      if (i !== index) return entry;
      if (field === "sourceHeader") {
        const target = mapping[i].target;
        const schemaField = inspected.targetSchema.find(f => f.name === target);
        const cast = { integer: "cast_number", number: "cast_number", boolean: "cast_boolean", date: "parse_date", local_datetime: "parse_local_datetime", string: "trim" }[schemaField?.type ?? "string"];
        const inner = { op: "field", name: value };
        return { target, expr: cast === "trim" ? { op: "trim", value: inner } : { op: cast, value: inner } };
      }
      return entry;
    });
    setMapping(next);
  }
  return (
    <div>
      <table className="grid">
        <thead><tr><th>Target column</th><th>Type</th><th>Source column</th></tr></thead>
        <tbody>
          {mapping.map((entry, index) => {
            const schemaField = inspected.targetSchema.find(f => f.name === entry.target);
            return (
              <tr key={entry.target}>
                <td>{entry.target}</td>
                <td>{schemaField?.type}</td>
                <td>
                  <select value={entry.expr?.op === "field" ? entry.expr.name : entry.expr?.value?.name ?? ""} onChange={event => update(index, "sourceHeader", event.target.value)}>
                    <option value=""></option>
                    {source.headers.map(header => <option key={header} value={header}>{header}</option>)}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Button onClick={onNext}>Review mapping</Button>
    </div>
  );
}

function MappingReview({ mapping, targetSchema, onBack, onNext }) {
  const covered = new Set(mapping.map(entry => entry.target));
  const missing = targetSchema.filter(field => !covered.has(field.name));
  return (
    <div>
      <p>{mapping.length} of {targetSchema.length} target columns mapped.</p>
      {missing.length > 0 && <Banner error={{ code: "MAPPING_INCOMPLETE", message: `Unmapped required columns: ${missing.map(m => m.name).join(", ")}` }} />}
      <Button onClick={onBack}>Back</Button>
      <Button onClick={onNext} disabled={missing.length > 0}>Next: Review and dry-run</Button>
    </div>
  );
}

function DryRunSummary({ dryRun, migration }) {
  const summary = dryRun?.dryRun ?? {};
  return (
    <div>
      <p>Dry-run completed against the planned source snapshot. Nothing has been written to the target.</p>
      <ul>
        <li>Rows processed: {summary.processedRows ?? "n/a"}</li>
        <li>Valid rows: {summary.validRows ?? "n/a"}</li>
        <li>Rejected rows: {summary.invalidRows ?? "n/a"}</li>
        <li>Plan: {String(summary.planId ?? "").slice(0, 19)}�</li>
      </ul>
      {summary.violations?.length > 0 && (
        <table className="grid">
          <thead><tr><th>Violation</th><th>Count</th></tr></thead>
          <tbody>{summary.violations.map(v => <tr key={v.code}><td>{v.code}</td><td>{v.count}</td></tr>)}</tbody>
        </table>
      )}
      <p>Migration: {migration?.migrationId}</p>
    </div>
  );
}

function ResultSummary({ result, migration, onNext }) {
  const receipt = result?.receipt;
  const status = receipt?.record?.status ?? "UNKNOWN";
  return (
    <div>
      <h3>{status === "COMPLETE" ? "Migration complete" : "Migration stopped"}</h3>
      <ul>
        <li>Status: {status}</li>
        <li>Written rows: {receipt?.record?.writtenRows ?? "n/a"}</li>
        <li>Migration: {migration?.migrationId}</li>
      </ul>
      <p>SPOOL internal ledger tables ({`__spool_batch_ledger`}, leases) stay untouched by the UI; receipts and verification evidence are recorded by the engine.</p>
      <Button onClick={onNext}>Start another migration</Button>
    </div>
  );
}
