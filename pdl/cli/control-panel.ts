import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'http';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { connect } from 'net';
import { join, resolve } from 'path';
import { TeamValidator } from '../../sim/team-validator';
import { Teams, type PokemonSet } from '../../sim/teams';
import { PDL_FORMAT_ID } from '../format';
import { validatePdlTeam } from '../validate-team';

const PANEL_PORT = Number(process.env.PORT) || Number(process.env.PANEL_PORT) || (process.env.SPACE_ID ? 7860 : 4173);
const SHOWDOWN_PORT = Number(process.env.SHOWDOWN_PORT) || 8000;
const FOUL_ROOT = process.env.FOUL_ROOT || (existsSync(resolve(__dirname, '../../../../pdl-s4-foul-play')) ? resolve(__dirname, '../../../../pdl-s4-foul-play') : '/Users/amanery/PDL Vercel App/pdl-s4-foul-play');
const SAMPLES_DIR = existsSync(resolve(__dirname, '../samples'))
	? resolve(__dirname, '../samples')
	: resolve(__dirname, '../../../pdl/samples');
const BELIEF_PATH = process.env.BELIEF_PATH || (
	existsSync(join(FOUL_ROOT, 'pdl-belief-all-teams.json'))
		? join(FOUL_ROOT, 'pdl-belief-all-teams.json')
		: (existsSync(resolve(__dirname, '../samples/pdl-belief-all-teams.json'))
			? resolve(__dirname, '../samples/pdl-belief-all-teams.json')
			: (existsSync(resolve(__dirname, '../../../pdl/samples/pdl-belief-all-teams.json'))
				? resolve(__dirname, '../../../pdl/samples/pdl-belief-all-teams.json')
				: (existsSync(join(FOUL_ROOT, 'pdl-belief-adam-vs-connor.json'))
					? join(FOUL_ROOT, 'pdl-belief-adam-vs-connor.json')
					: (existsSync(resolve(__dirname, '../studies/adam-vs-steve-team-strategy/belief.json'))
						? resolve(__dirname, '../studies/adam-vs-steve-team-strategy/belief.json')
						: resolve(__dirname, '../../../pdl/studies/adam-vs-steve-team-strategy/belief.json')))))
);
const PANEL_TEAM_PATH = process.env.PANEL_TEAM_PATH || (existsSync('/tmp') ? '/tmp/pdl-foul-play-control-team.txt' : '/private/tmp/pdl-foul-play-control-team.txt');
const SAMPLE_PATHS: Record<string, string> = {
	adam: '/Users/amanery/Downloads/Adam Sample Team.txt',
	connor: '/Users/amanery/Downloads/Connor Sample Team.txt',
};

export function getSampleTeam(teamId: string, variationIndex = 1): string {
	const normalized = (teamId || '').toLowerCase().trim();
	const catalogPath = join(SAMPLES_DIR, 'pdl-all-coaches-10teams.json');
	if (existsSync(catalogPath)) {
		try {
			const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
			const list = catalog[normalized];
			if (Array.isArray(list) && list.length > 0) {
				const match = list.find((item: any) => item.index === variationIndex) || list[0];
				if (match?.export) return match.export;
			}
		} catch {
			// fall back to file
		}
	}
	const bundledPath = join(SAMPLES_DIR, `${normalized}.txt`);
	const path = existsSync(bundledPath) ? bundledPath : SAMPLE_PATHS[normalized];
	if (!path || !existsSync(path)) throw new Error(`No saved sample file for ${normalized}.`);
	return readFileSync(path, 'utf8');
}

interface ControlStartInput {
	teamId: unknown;
	opponentTeamId?: unknown;
	matches: unknown;
	teamExport: unknown;
}

export interface ControlStart {
	readonly teamId: string;
	readonly opponentTeamId?: string;
	readonly matches: number;
	readonly teamExport: string;
}

interface BeliefRosterPokemon { readonly species: string; readonly cost: number; }
interface BeliefTeam { readonly draftedTeraTypes: readonly string[]; readonly roster: readonly BeliefRosterPokemon[]; }
interface BeliefFile { readonly teams: Readonly<Record<string, BeliefTeam>>; }

interface ManagedProcess {
	readonly child: ChildProcessWithoutNullStreams;
	stdout: string;
	stderr: string;
}

export function formatProcessExit(processOutput: Pick<ManagedProcess, 'stdout' | 'stderr'>): string {
	return `Foul Play exited:\n${processOutput.stderr || processOutput.stdout || 'No startup output was captured.'}`;
}

/** Writes the current panel build to a stable path Foul Play can reopen for every challenge. */
export function saveControlBotTeam(teamExport: string): string {
	writeFileSync(PANEL_TEAM_PATH, teamExport, 'utf8');
	return PANEL_TEAM_PATH;
}

let showdown: ManagedProcess | null = null;
let bot: ManagedProcess | null = null;
let panelNotice = 'Ready.';

function text(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
	return value.trim();
}

/** Strictly validates the small JSON contract accepted by the local panel. */
export function parseControlStart(value: ControlStartInput): ControlStart {
	const teamId = text(value.teamId, 'Bot roster').toLowerCase();
	const rawOpponent = typeof value.opponentTeamId === 'string' ? value.opponentTeamId.trim().toLowerCase() : '';
	const opponentTeamId = rawOpponent || (teamId === 'adam' ? 'connor' : 'adam');
	if (teamId === rawOpponent) throw new Error('Bot and opponent rosters must be different.');
	const matches = typeof value.matches === 'number' ? value.matches : Number(value.matches);
	if (!Number.isInteger(matches) || matches < 1 || matches > 1000) throw new Error('Matches must be a whole number from 1 to 1000.');
	return { teamId, opponentTeamId, matches, teamExport: text(value.teamExport, 'Team export') };
}

/** Current maintained Showdown rewrite client pointed at this local server. */
export function buildControlClientUrl(): string {
	if (process.env.PUBLIC_URL) {
		const clean = process.env.PUBLIC_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
		return `https://play.pokemonshowdown.com/testclient-new.html?~~${clean}`;
	}
	if (process.env.FLY_APP_NAME) {
		return `https://play.pokemonshowdown.com/testclient-new.html?~~${process.env.FLY_APP_NAME}.fly.dev`;
	}
	if (process.env.RAILWAY_PUBLIC_DOMAIN) {
		return `https://play.pokemonshowdown.com/testclient-new.html?~~${process.env.RAILWAY_PUBLIC_DOMAIN}`;
	}
	if (process.env.RENDER_EXTERNAL_HOSTNAME) {
		return `https://play.pokemonshowdown.com/testclient-new.html?~~${process.env.RENDER_EXTERNAL_HOSTNAME}`;
	}
	if (process.env.SPACE_HOST) {
		return `https://play.pokemonshowdown.com/testclient-new.html?~~${process.env.SPACE_HOST}`;
	}
	if (process.env.SPACE_ID) {
		const clean = process.env.SPACE_ID.replace('/', '-').toLowerCase();
		return `https://play.pokemonshowdown.com/testclient-new.html?~~${clean}.hf.space`;
	}
	const host = process.env.SHOWDOWN_HOST || 'localhost';
	const port = process.env.SHOWDOWN_PORT ? Number(process.env.SHOWDOWN_PORT) : SHOWDOWN_PORT;
	return `https://play.pokemonshowdown.com/testclient-new.html?~~${host}:${port}`;
}

let cachedBelief: BeliefFile | null = null;
function belief(): BeliefFile {
	if (cachedBelief) return cachedBelief;
	if (!existsSync(BELIEF_PATH)) throw new Error(`Missing local belief file: ${BELIEF_PATH}`);
	cachedBelief = JSON.parse(readFileSync(BELIEF_PATH, 'utf8')) as BeliefFile;
	return cachedBelief;
}

function toLeague(data: BeliefFile) {
	return { teams: Object.entries(data.teams).map(([id, team]) => ({
		id,
		name: id[0].toUpperCase() + id.slice(1),
		draftedTeraTypes: [...team.draftedTeraTypes],
		roster: team.roster.map(pokemon => ({ ...pokemon })),
	})) };
}

function validateBotTeam(start: ControlStart): PokemonSet[] {
	const data = belief();
	if (!data.teams[start.teamId]) throw new Error(`No local PDL roster data exists for ${start.teamId}.`);
	if (start.opponentTeamId && !data.teams[start.opponentTeamId]) throw new Error(`No local PDL roster data exists for ${start.opponentTeamId}.`);
	const team = Teams.import(start.teamExport);
	if (!team) throw new Error('Team export could not be parsed by Pokémon Showdown.');
	const errors = [
		...validatePdlTeam({ league: toLeague(data), teamId: start.teamId, team }),
		...(TeamValidator.get(PDL_FORMAT_ID).validateTeam(team) || []),
	];
	if (errors.length) throw new Error(errors.join('\n'));
	return team;
}

function spawnCollected(command: string, args: string[], cwd: string, onExit: () => void): ManagedProcess {
	const child = spawn(command, args, { cwd, stdio: 'pipe' });
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', chunk => { stdout += chunk; });
	child.stderr.on('data', chunk => { stderr += chunk; });
	child.once('close', onExit);
	return { child, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

function stop(processOutput: ManagedProcess | null): void {
	if (processOutput && !processOutput.child.killed && processOutput.child.exitCode === null) processOutput.child.kill('SIGTERM');
}

async function portIsOpen(port: number): Promise<boolean> {
	return await new Promise(resolvePromise => {
		const socket = connect({ host: '127.0.0.1', port });
		socket.once('connect', () => { socket.destroy(); resolvePromise(true); });
		socket.once('error', () => { socket.destroy(); resolvePromise(false); });
	});
}

async function startShowdown(): Promise<void> {
	if (await portIsOpen(SHOWDOWN_PORT)) {
		panelNotice = showdown ? 'Local Showdown is running.' : 'A local server is already using port 8000; the panel will use it without stopping it.';
		return;
	}
	const root = resolve(__dirname, '..', '..', '..');
	showdown = spawnCollected(process.execPath, ['pokemon-showdown', 'start', '--skip-build', '--no-security', String(SHOWDOWN_PORT)], root, () => {
		showdown = null;
		panelNotice = 'Panel-managed Showdown stopped.';
	});
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (await portIsOpen(SHOWDOWN_PORT)) {
			panelNotice = 'Local Showdown is running.';
			return;
		}
		if (showdown.child.exitCode !== null) throw new Error(`Showdown exited:\n${showdown.stderr}`);
		await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
	}
	throw new Error('Timed out starting local Showdown.');
}

async function startBot(start: ControlStart): Promise<void> {
	if (bot?.child.exitCode === null) {
		stop(bot);
		bot = null;
	}
	validateBotTeam(start);
	await startShowdown();
	const venvPython = join(FOUL_ROOT, '.venv', 'bin', 'python');
	const python = process.env.PYTHON_BIN || (existsSync(venvPython) ? venvPython : 'python3');
	const teamPath = saveControlBotTeam(start.teamExport);
	const startedBot = spawnCollected(python, [
		'run.py', '--websocket-uri', `ws://127.0.0.1:${SHOWDOWN_PORT}/showdown/websocket`,
		'--ps-username', 'PDL Foul Play', '--bot-mode', 'accept_challenge', '--pokemon-format', PDL_FORMAT_ID,
		'--pdl-belief-data', BELIEF_PATH, '--pdl-team-id', start.teamId, '--belief-zero-policy', 'restore', '--team-name', teamPath,
		'--local-no-security', '--search-time-ms', '250', '--run-count', String(start.matches), '--log-level', 'INFO',
		'--offline-runtime', '--search-engine', 'mcts', '--action-policy', 'argmax',
	], FOUL_ROOT, () => {
		if (bot === startedBot) bot = null;
		panelNotice = 'PDL Foul Play stopped.';
	});
	bot = startedBot;
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (/Waiting for a gen9pdls4 challenge/.test(startedBot.stdout)) {
			panelNotice = `PDL Foul Play is waiting for up to ${start.matches} matches as ${start.teamId}.`;
			return;
		}
		if (startedBot.child.exitCode !== null) throw new Error(formatProcessExit(startedBot));
		await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
	}
	stop(startedBot);
	throw new Error('Timed out waiting for Foul Play to connect.');
}

async function status() {
	const runningPort = await portIsOpen(SHOWDOWN_PORT);
	return {
		showdown: Boolean((showdown && showdown.child.exitCode === null) || runningPort),
		port8000: runningPort,
		bot: Boolean(bot && bot.child.exitCode === null),
		notice: panelNotice,
		clientUrl: buildControlClientUrl(),
		botLog: bot ? `${bot.stdout}${bot.stderr}`.slice(-4000) : '',
		showdownLog: showdown ? `${showdown.stdout}${showdown.stderr}`.slice(-2000) : '',
		teams: Object.keys(belief().teams),
	};
}

async function body(request: IncomingMessage): Promise<unknown> {
	let raw = '';
	for await (const chunk of request) raw += chunk;
	return raw ? JSON.parse(raw) : {};
}

function respond(response: ServerResponse, statusCode: number, value: unknown): void {
	response.writeHead(statusCode, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'access-control-allow-origin': '*',
		'access-control-allow-methods': 'GET, POST, OPTIONS',
		'access-control-allow-headers': 'Content-Type, Authorization',
	});
	response.end(`${JSON.stringify(value)}\n`);
}

export function renderControlPanelHtml(): string {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PDL Foul Play</title><style>
body{margin:0;background:#07111f;color:#e8f0ff;font:15px ui-sans-serif,system-ui,-apple-system,sans-serif}main{max-width:1050px;margin:36px auto;padding:0 20px}.card{background:#101e32;border:1px solid #263d5d;border-radius:14px;padding:22px;margin:16px 0}h1{margin:0 0 8px}p{color:#aac0db}label{display:block;font-weight:700;margin:14px 0 5px}select,input,textarea,button{box-sizing:border-box;width:100%;font:inherit;border-radius:8px;border:1px solid #3b5578;background:#0a1525;color:#eef5ff;padding:10px}textarea{height:330px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.35}button{width:auto;background:#4b83d5;border:0;font-weight:800;cursor:pointer;margin:12px 8px 0 0}button.stop{background:#a9434d}button.alt{background:#283e5d}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.status{padding:12px;border-radius:9px;background:#0b1728;white-space:pre-wrap}.ok{color:#8bdfa0}.off{color:#ffb3a8}pre{white-space:pre-wrap;max-height:180px;overflow:auto;color:#b9cbe3}@media(max-width:650px){.grid{grid-template-columns:1fr}}
</style></head><body><main><h1>PDL Foul Play</h1><p>Local-only control panel. It uses your supplied team export, a local PDL belief file, and the local Showdown server.</p><section class="card"><div id="state" class="status">Loading…</div><button class="alt" id="open">Open battle client</button><button class="alt" id="showdown">Start local Showdown</button><button class="stop" id="stop">Stop bot</button></section><section class="card"><div class="grid"><div><label for="team">Bot roster</label><select id="team"><option value="adam">Adam</option><option value="connor" selected>Connor</option><option value="steve">Steve</option><option value="jon">Jon</option><option value="greg">Greg</option><option value="jordan">Jordan</option><option value="zander">Zander</option><option value="nick">Nick</option></select></div><div><label for="opponent">Your roster</label><select id="opponent"><option value="adam" selected>Adam</option><option value="connor">Connor</option><option value="steve">Steve</option><option value="jon">Jon</option><option value="greg">Greg</option><option value="jordan">Jordan</option><option value="zander">Zander</option><option value="nick">Nick</option></select></div></div><label for="matches">Matches before the bot exits</label><input id="matches" type="number" min="1" max="1000" value="100"><label for="export">Bot’s exact Showdown team</label><textarea id="export" spellcheck="false" placeholder="Paste a complete six-Pokémon Showdown export here"></textarea><button class="alt" id="sample">Load selected sample</button><button id="start">Validate & start PDL Foul Play</button><pre id="log"></pre></section></main><script>
const $=id=>document.getElementById(id); async function api(path,method='GET',data){const r=await fetch(path,{method,headers:{'content-type':'application/json'},body:data?JSON.stringify(data):undefined});const j=await r.json();if(!r.ok)throw Error(j.error);return j} function show(s){$('state').innerHTML='<b class="'+(s.bot?'ok':'off')+'">Bot: '+(s.bot?'running':'stopped')+'</b> · <b class="'+(s.showdown?'ok':'off')+'">Panel Showdown: '+(s.showdown?'running':'not managed')+'</b>\\n'+s.notice;$('log').textContent=s.botLog||s.showdownLog||'';$('open').onclick=()=>window.open(s.clientUrl,'_blank')} async function refresh(){try{show(await api('/api/status'))}catch(e){$('state').textContent=e.message}} $('showdown').onclick=async()=>{try{show(await api('/api/showdown','POST'))}catch(e){alert(e.message);refresh()}}; $('stop').onclick=async()=>{try{show(await api('/api/stop','POST'))}catch(e){alert(e.message);refresh()}}; $('sample').onclick=async()=>{try{$('export').value=(await api('/api/sample?teamId='+encodeURIComponent($('team').value))).teamExport}catch(e){alert(e.message)}}; $('start').onclick=async()=>{try{show(await api('/api/start','POST',{teamId:$('team').value,opponentTeamId:$('opponent').value,matches:Number($('matches').value),teamExport:$('export').value}))}catch(e){alert(e.message);refresh()}}; refresh(); setInterval(refresh,1500);
</script></body></html>`;
}

function proxyToShowdown(request: IncomingMessage, response: ServerResponse): void {
	const proxyReq = httpRequest({
		host: '127.0.0.1',
		port: SHOWDOWN_PORT,
		path: request.url,
		method: request.method,
		headers: request.headers,
	}, (proxyRes) => {
		response.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
		proxyRes.pipe(response);
	});
	proxyReq.on('error', () => {
		respond(response, 502, { error: 'Showdown server unreachable.' });
	});
	request.pipe(proxyReq);
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
	try {
		if (request.method === 'OPTIONS') {
			response.writeHead(204, {
				'access-control-allow-origin': '*',
				'access-control-allow-methods': 'GET, POST, OPTIONS',
				'access-control-allow-headers': 'Content-Type, Authorization',
			});
			response.end();
			return;
		}
		if (request.method === 'GET' && request.url === '/') {
			response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(renderControlPanelHtml()); return;
		}
		if (request.method === 'GET' && request.url === '/api/status') { respond(response, 200, await status()); return; }
		if (request.method === 'GET' && request.url?.startsWith('/api/sample?')) {
			const u = new URL(request.url, 'http://127.0.0.1');
			const teamId = u.searchParams.get('teamId') || '';
			const variationIndex = Number(u.searchParams.get('variation')) || 1;
			try {
				const teamExport = getSampleTeam(teamId, variationIndex);
				respond(response, 200, { teamExport });
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				respond(response, 404, { error: message });
			}
			return;
		}
		if (request.method === 'GET' && request.url?.startsWith('/api/variations')) {
			const u = new URL(request.url, 'http://127.0.0.1');
			const teamId = (u.searchParams.get('teamId') || '').toLowerCase().trim();
			const catalogPath = join(SAMPLES_DIR, 'pdl-all-coaches-10teams.json');
			if (existsSync(catalogPath)) {
				try {
					const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
					if (teamId && catalog[teamId]) {
						respond(response, 200, { teamId, variations: catalog[teamId] });
						return;
					}
					respond(response, 200, { variations: catalog });
					return;
				} catch (err: unknown) {
					const message = err instanceof Error ? err.message : String(err);
					respond(response, 500, { error: message });
					return;
				}
			}
			respond(response, 404, { error: 'No variations catalog found' });
			return;
		}
		if (request.method === 'POST' && request.url === '/api/showdown') { await startShowdown(); respond(response, 200, await status()); return; }
		if (request.method === 'POST' && request.url === '/api/start') { await startBot(parseControlStart(await body(request) as ControlStartInput)); respond(response, 200, await status()); return; }
		if (request.method === 'POST' && request.url === '/api/stop') { stop(bot); bot = null; panelNotice = 'PDL Foul Play stopped.'; respond(response, 200, await status()); return; }
		if (request.url?.startsWith('/showdown') || request.url?.startsWith('/action.php')) {
			proxyToShowdown(request, response);
			return;
		}
		respond(response, 404, { error: 'Not found.' });
	} catch (error) { respond(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
}

if (require.main === module) {
	const server = createServer((request, response) => { void handle(request, response); });
	server.on('upgrade', (req, socket, head) => {
		const showdownSocket = connect(SHOWDOWN_PORT, '127.0.0.1', () => {
			showdownSocket.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
			for (let i = 0; i < req.rawHeaders.length; i += 2) {
				showdownSocket.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
			}
			showdownSocket.write('\r\n');
			if (head && head.length) showdownSocket.write(head);
			socket.pipe(showdownSocket).pipe(socket);
		});
		showdownSocket.on('error', () => socket.destroy());
		socket.on('error', () => showdownSocket.destroy());
	});
	const bindHost = process.env.BIND_HOST || '0.0.0.0';
	server.listen(PANEL_PORT, bindHost, () => process.stdout.write(`PDL Foul Play control panel: http://${bindHost}:${PANEL_PORT}\n`));
	process.once('SIGINT', () => { stop(bot); stop(showdown); server.close(); });
}
