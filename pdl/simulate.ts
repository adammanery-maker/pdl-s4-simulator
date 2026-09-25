import { BattleStream, getPlayerStreams } from '../sim/battle-stream';
import { TeamValidator } from '../sim/team-validator';
import { Teams } from '../sim/teams';
import { RandomPlayerAI } from '../sim/tools/random-player-ai';
import { PDL_FORMAT_ID } from './format';
import type { PdlBattleInput, PdlBattleRecord, PdlBattleSide } from './types';
import { validatePdlTeam } from './validate-team';

export const SHOWDOWN_COMMIT = '2180a5c998b9c930863c5734ab7500bbd301952a';

/** Removes only Showdown's wall-clock protocol annotation. */
export function canonicalizeProtocolLog(protocolLog: string[]): string[] {
	return protocolLog.map(chunk => chunk.replace(/\|t:\|\d+/g, '|t:|'));
}

class RecordingPlayerAI extends RandomPlayerAI {
	readonly choices: string[] = [];

	override choose(choice: string) {
		this.choices.push(choice);
		super.choose(choice);
	}
}

function validateSide(input: PdlBattleInput, side: PdlBattleSide): void {
	const pdlErrors = validatePdlTeam({ league: input.league, teamId: side.teamId, team: side.team });
	const showdownErrors = TeamValidator.get(PDL_FORMAT_ID).validateTeam(side.team);
	const errors = [...pdlErrors, ...(showdownErrors || [])];
	if (errors.length) throw new Error(`${side.name}'s team is invalid:\n${errors.join('\n')}`);
}

function cloneTeam(team: PdlBattleSide['team']): PdlBattleSide['team'] {
	return team.map(set => ({
		...set,
		moves: [...set.moves],
		...(set.evs ? { evs: { ...set.evs } } : {}),
		...(set.ivs ? { ivs: { ...set.ivs } } : {}),
	}));
}

export async function simulatePdlBattle(input: PdlBattleInput): Promise<PdlBattleRecord> {
	const recordedP1Team = cloneTeam(input.p1.team);
	const recordedP2Team = cloneTeam(input.p2.team);
	const battleInput: PdlBattleInput = {
		...input,
		p1: { ...input.p1, team: cloneTeam(input.p1.team) },
		p2: { ...input.p2, team: cloneTeam(input.p2.team) },
	};
	validateSide(battleInput, battleInput.p1);
	validateSide(battleInput, battleInput.p2);

	const streams = getPlayerStreams(new BattleStream());
	const p1 = new RecordingPlayerAI(streams.p1, { move: 1, mega: 0, seed: 'gen5,00000000,00000000,00000002' });
	const p2 = new RecordingPlayerAI(streams.p2, { move: 1, mega: 0, seed: 'gen5,00000000,00000000,00000003' });
	const protocolLog: string[] = [];
	const collectLog = (async () => {
		for await (const chunk of streams.omniscient) protocolLog.push(chunk);
	})();

	void p1.start();
	void p2.start();
	await streams.omniscient.write(`>start ${JSON.stringify({ formatid: PDL_FORMAT_ID, seed: input.seed })}
>player p1 ${JSON.stringify({ name: battleInput.p1.name, team: Teams.pack(battleInput.p1.team) })}
>player p2 ${JSON.stringify({ name: battleInput.p2.name, team: Teams.pack(battleInput.p2.team) })}`);
	await collectLog;

	const winnerLine = protocolLog.flatMap(chunk => chunk.split('\n')).find(line => line.startsWith('|win|'));
	if (!winnerLine) throw new Error('Showdown ended the battle without a winner.');

	return {
		winner: winnerLine.slice('|win|'.length),
		seed: input.seed,
		formatId: PDL_FORMAT_ID,
		showdownCommit: SHOWDOWN_COMMIT,
		protocolLog,
		canonicalProtocolLog: canonicalizeProtocolLog(protocolLog),
		p1Team: recordedP1Team,
		p2Team: recordedP2Team,
		choices: { p1: p1.choices, p2: p2.choices },
	};
}
