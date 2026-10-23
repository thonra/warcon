import type { GroupConfig } from './contracts';

export interface MessagingSettings {
	provider: 'napcat' | 'official';
	appId: string;
	appSecret: string;
	/** Command buttons insert text into QQ; they never directly execute game operations. */
	buttons?: boolean;
	/** Explicitly approved C2C testers; reuse one existing community/server policy per identity. */
	privateTests?: { appId: string; userOpenid: string; groupId: string }[];
}
export const defaultMessaging = (): MessagingSettings => ({
	provider: 'napcat',
	appId: '',
	appSecret: ''
});
export type PublicMessaging = Omit<MessagingSettings, 'appSecret'> & { appSecretSet: boolean };

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
	messaging?: MessagingSettings;
	servers: ManagedServer[];
	groups: GroupConfig[];
}
export interface PublicSettings {
	messaging?: PublicMessaging;
	/** Persisted configuration version; every replacement must match the version read. */
	revision: number;
	servers: PublicServer[];
	groups: GroupConfig[];
}
/** Config POST includes all visible fields; blank secrets preserve the existing secret by ID. */
export interface SettingsUpdate {
	messaging?: PublicMessaging & { appSecret?: string };
	revision: number;
	servers: (PublicServer & { password?: string; warconToken?: string })[];
	groups: GroupConfig[];
}
