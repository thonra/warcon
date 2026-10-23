/** Transport-independent bot contracts. All identifiers are strings (never round Steam IDs). */
export type TeamColor = '蓝' | '红' | '绿';
export interface GroupConfig {
	groupId: string;
	/** Explicit official-channel mapping. A raw QQ group number is never an OpenID. */
	officialGroupId?: string;
	officialAppId?: string;
	communityId: string;
	serverId: string;
	serverName: string;
	timezone: string;
	checkinPoints: number;
	moveCost: number;
	moveCooldownSeconds: number;
	/** Explicit mapping to names returned by the current game's status API. */
	factions: Record<TeamColor, string>;
}
export interface BotMessage {
	id: string;
	groupId: string;
	userId: string;
	text: string;
	time: number;
	/** Stamped by the authenticated transport, never taken from incoming QQ text. */
	configurationRevision?: string;
	/** Only reply routing metadata survives command completion, never command text or verification codes. */
	officialReply?: {
		appId: string;
		messageId: string;
		revision: string;
	} & ({ scope?: 'group'; groupOpenid: string } | { scope: 'c2c'; userOpenid: string });
}
export interface GamePlayer {
	steamId: string;
	name: string;
	faction: string | null;
	kills: number;
	deaths: number;
	ping: number | null;
}
export interface GameSnapshot {
	map: string;
	playerCount: number;
	maxPlayers: number;
	scores: { name: string; score: number }[];
	players: GamePlayer[];
	/** Time of the actual reads, not a cached live view. */
	observedAt: number;
	canMove: boolean;
}
export interface ReservedStatus {
	state: 'none' | 'active' | 'pending' | 'unknown';
	expiresAt: string | null;
}
export interface WarconPort {
	snapshot(serverId: string): Promise<GameSnapshot>;
	whisper(serverId: string, steamId: string, message: string): Promise<void>;
	move(serverId: string, steamId: string, faction: string): Promise<void>;
	reserved(serverId: string, steamId: string): Promise<ReservedStatus>;
}
/** A refusal is known not to have changed the game; ambiguous transport/server errors are unknown. */
export class WarconError extends Error {
	constructor(
		message: string,
		readonly effect: 'refused' | 'unknown' = 'unknown'
	) {
		super(message);
	}
}
export interface BotHandler {
	handle(message: BotMessage, group: GroupConfig): Promise<string>;
}
