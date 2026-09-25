import type { MoveSummary, RecordSummary, SimulationSummary } from '../analysis/aggregate';

export interface SimulationReportMetadata {
	readonly snapshotHash: string;
	readonly completedTrials: number;
	readonly rejectedTrials: number;
	readonly failedTrials: number;
	readonly timedOutTrials: number;
	readonly constraints?: Readonly<Record<string, unknown>>;
	readonly experiment?: ExperimentReportMetadata;
}

export interface ExperimentReportVariant {
	readonly id: string;
	readonly teamId: string;
	readonly species: readonly string[];
}

export interface ExperimentReportMetadata {
	readonly leftTeamId: string;
	readonly rightTeamId: string;
	readonly totalPairs: number;
	readonly leftVariants: readonly ExperimentReportVariant[];
	readonly rightVariants: readonly ExperimentReportVariant[];
}

export interface SimulationReportInput {
	readonly metadata: SimulationReportMetadata;
	readonly analysis: SimulationSummary;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

function prettyId(value: string): string {
	return value.split(/[-_:]/).map(word => word ? `${word[0].toUpperCase()}${word.slice(1)}` : '').join(' ');
}

function formatSet(id: string): string {
	const [species, ability, item, nature, teraType, hp, atk, def, spa, spd, spe, ...moves] = id.split('|');
	return `${prettyId(species)} @ ${prettyId(item)} — ${prettyId(ability)} — ${prettyId(nature)} — EVs ${hp}/${atk}/${def}/${spa}/${spd}/${spe}${teraType ? ` — Tera ${prettyId(teraType)}` : ''} — ${moves.map(prettyId).join(' / ')}`;
}

function percentage(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function recordRows(records: readonly RecordSummary[], label: (id: string) => string): string {
	return records.map(record => `<tr><td>${escapeHtml(label(record.id))}</td><td>${record.appearances}</td><td>${record.wins}-${record.losses}</td><td>${percentage(record.winRate)}</td><td>${percentage(record.interval[0])}–${percentage(record.interval[1])}</td></tr>`).join('');
}

function recordTable(title: string, records: readonly RecordSummary[], label = prettyId): string {
	return `<section><h2>${title}</h2><table><thead><tr><th>Entity</th><th>Samples</th><th>Record</th><th>Win rate</th><th>95% Wilson interval</th></tr></thead><tbody>${recordRows(records, label) || '<tr><td colspan="5">No complete, balanced observations.</td></tr>'}</tbody></table></section>`;
}

function speciesList(species: readonly string[]): string {
	return species.map(prettyId).join(' · ');
}

function experimentVariantTable(metadata: ExperimentReportMetadata, records: readonly RecordSummary[]): string {
	const recordById = new Map(records.map(record => [record.id, record]));
	const row = (variant: ExperimentReportVariant, side: string) => {
		const record = recordById.get(variant.id);
		return `<tr><td>${escapeHtml(prettyId(variant.id))}</td><td>${escapeHtml(prettyId(variant.teamId))} (${side})</td><td>${escapeHtml(speciesList(variant.species))}</td><td>${record ? record.appearances / 2 : 0}</td><td>${record ? `${record.wins}-${record.losses}` : '—'}</td><td>${record ? percentage(record.winRate) : '—'}</td><td>${record ? `${percentage(record.interval[0])}–${percentage(record.interval[1])}` : '—'}</td></tr>`;
	};
	return `<section><h2>Roster variant results</h2><p class="note">Each row is one fixed six. “Pairs” counts balanced forward/reverse matchup pairs; record and win rate count the resulting individual battles.</p><table><thead><tr><th>Variant</th><th>Team</th><th>Resolved six</th><th>Pairs</th><th>Battle record</th><th>Win rate</th><th>95% Wilson interval</th></tr></thead><tbody>${metadata.leftVariants.map(variant => row(variant, 'left')).join('')}${metadata.rightVariants.map(variant => row(variant, 'right')).join('')}</tbody></table></section>`;
}

function experimentCellTable(metadata: ExperimentReportMetadata, records: readonly RecordSummary[]): string {
	const leftById = new Map(metadata.leftVariants.map(variant => [variant.id, variant]));
	const rightById = new Map(metadata.rightVariants.map(variant => [variant.id, variant]));
	const rows = records.map(record => {
		const [leftId, rightId] = record.id.split('__');
		const left = leftById.get(leftId);
		const right = rightById.get(rightId);
		return `<tr><td>${escapeHtml(prettyId(leftId))}</td><td>${escapeHtml(left ? speciesList(left.species) : 'Unknown')}</td><td>${escapeHtml(prettyId(rightId))}</td><td>${escapeHtml(right ? speciesList(right.species) : 'Unknown')}</td><td>${record.appearances / 2}</td><td>${record.wins}-${record.losses}</td><td>${percentage(record.winRate)}</td><td>${percentage(record.interval[0])}–${percentage(record.interval[1])}</td></tr>`;
	}).join('');
	return `<section><h2>Cross-matchup results</h2><p class="note">Every row compares the left-side fixed six against the right-side fixed six. The record and win rate are from the left team’s perspective; pairs are played on both player sides.</p><table><thead><tr><th>Left variant</th><th>Left six</th><th>Right variant</th><th>Right six</th><th>Pairs</th><th>Left battle record</th><th>Left win rate</th><th>95% Wilson interval</th></tr></thead><tbody>${rows || '<tr><td colspan="8">No complete, balanced observations.</td></tr>'}</tbody></table></section>`;
}

function moveTable(records: readonly MoveSummary[]): string {
	const rows = records.map(record => `<tr><td>${escapeHtml(prettyId(record.id))}</td><td>${record.uses}</td><td>${record.kos}</td><td>${record.damagePercent.toFixed(1)}%</td><td>${record.wins}-${record.losses}</td><td>${percentage(record.winRate)}</td><td>${percentage(record.interval[0])}–${percentage(record.interval[1])}</td></tr>`).join('');
	return `<section><h2>Moves</h2><table><thead><tr><th>Move</th><th>Uses</th><th>KOs</th><th>Recorded damage</th><th>Win/loss uses</th><th>Win rate</th><th>95% Wilson interval</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No complete, balanced observations.</td></tr>'}</tbody></table></section>`;
}

function constraintPanel(constraints: Readonly<Record<string, unknown>> | undefined): string {
	if (!constraints) return '';
	return `<section><h2>Run constraints</h2><p class="note">Required, excluded, and locked Pokémon/builds supplied to the terminal command. These constraints apply only to this local run.</p><pre>${escapeHtml(JSON.stringify(constraints, null, 2))}</pre></section>`;
}

/** Renders a self-contained local report; it never fetches or writes league state. */
export function renderSimulationReport(input: SimulationReportInput): string {
	const { metadata, analysis } = input;
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PDL Local Simulation Report</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:1400px;margin:32px auto;padding:0 20px;background:#10131a;color:#eef2ff}h1,h2{color:#f8fafc}section{margin:28px 0;padding:18px;background:#171c27;border:1px solid #283248;border-radius:10px;overflow-x:auto}.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.meta div{padding:12px;background:#171c27;border-radius:8px}.meta strong{display:block;color:#9fb3d9;font-size:.8rem;text-transform:uppercase}table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{text-align:left;padding:9px;border-bottom:1px solid #2b354a;vertical-align:top}th{color:#a7c7ff;white-space:nowrap}td:first-child{min-width:180px}.note{color:#c5d1e8;line-height:1.55}</style></head><body>
<h1>PDL Local Simulation Report</h1>
<p class="note"><strong>Descriptive simulation association:</strong> rankings show outcomes observed in completed, side-balanced local trials. They are not causal player, Pokémon, move, or build valuations. Every rate includes its sample count and 95% Wilson interval.</p>
<div class="meta"><div><strong>Snapshot hash</strong>${escapeHtml(metadata.snapshotHash)}</div><div><strong>Balanced pairs</strong>${analysis.completedPairCount}</div><div><strong>Completed trials</strong>${metadata.completedTrials}</div><div><strong>Rejected / failed / timed out</strong>${metadata.rejectedTrials} / ${metadata.failedTrials} / ${metadata.timedOutTrials}</div><div><strong>Excluded unpaired trials</strong>${analysis.excludedTrialCount}</div></div>
${constraintPanel(metadata.constraints)}
${recordTable('Team records', analysis.teamRecords)}
${metadata.experiment ? experimentVariantTable(metadata.experiment, analysis.variantRecords) : recordTable('Variant records', analysis.variantRecords)}
${metadata.experiment ? experimentCellTable(metadata.experiment, analysis.cellRecords) : recordTable('Cross-matchup cells', analysis.cellRecords)}
${recordTable('Pokémon records', analysis.pokemonRecords)}
${recordTable('Exact builds', analysis.setRecords, formatSet)}
${moveTable(analysis.moveRecords)}
${recordTable('Teammate pairs', analysis.teammatePairs, value => value.split('+').map(prettyId).join(' + '))}
${recordTable('Leads', analysis.leadRecords)}
${recordTable('Tera uses', analysis.teraRecords, value => value.split(':').map(prettyId).join(' → '))}
</body></html>`;
}
