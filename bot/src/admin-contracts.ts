import type { GroupConfig } from './contracts';

export interface ManagedServer {
	id: string;
	name: string;
	mode: 'wardogs' | 'warcon';
	scheme: 'http' | 'https';
	host: string;
	port: number;
	/** Decrypted only inside the bot. Never included in a management GET response. */
	password: string;
	warconUrl: string;
	warconToken: string;
}
export type PublicServer = Omit<ManagedServer, 'password' | 'warconToken'> & {
	passwordSet: boolean;
	warconTokenSet: boolean;
};
export interface ManagedSettings {
	servers: ManagedServer[];
	groups: GroupConfig[];
}
export interface PublicSettings {
	/** Persisted configuration version; every replacement must match the version read. */
	revision: number;
	servers: PublicServer[];
	groups: GroupConfig[];
}
/** Config POST includes all visible fields; blank secrets preserve the existing secret by ID. */
export interface SettingsUpdate {
	revision: number;
	servers: (PublicServer & { password?: string; warconToken?: string })[];
	groups: GroupConfig[];
}
