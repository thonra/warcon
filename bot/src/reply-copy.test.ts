import { expect, test } from 'bun:test';
import { renderReply, validateReplies, groupReply, type ReplyOverrides } from './reply-copy';
import { BotStore } from './store';
import { CommandHandler } from './commands';
import type { GroupConfig } from './contracts';

test('templates validate allowed variables, confirmation commands and default restoration', () => {
	expect(validateReplies({ 'group.suffix': '' })).toEqual({});
	expect(validateReplies({ 'help.title': '欢迎 {serverName}' })).toEqual({
		'help.title': '欢迎 {serverName}'
	});
	for (const bad of [
		null,
		[],
		{ unknown: 'text' },
		{ 'help.title': '{appSecret}' },
		{ 'help.title': 'unclosed {' },
		{ 'help.title': '' },
		{ 'help.title': 'a'.repeat(2001) },
		{ 'move.quote': '发送 /确认 {code}' },
		{ 'move.quote': '{faction} {cost} {code}' }
	])
		expect(() => validateReplies(bad)).toThrow();
	const quote = validateReplies({ 'move.quote': '{faction} / 费用 {cost}\n发送 /确认 {code}' });
	expect(renderReply('move.quote', { faction: 'Blue', cost: 3, code: '123456' }, quote)).toBe(
		'Blue / 费用 3\n发送 /确认 123456'
	);
	expect(
		renderReply('help.title', { serverName: '<img>{cost}' }, { 'help.title': '欢迎 {serverName}' })
	).toBe('欢迎 <img>{cost}');
	expect(groupReply('正文')).toBe('正文');
	expect(groupReply('正文', { 'group.suffix': '附加文字' })).toBe('正文\n附加文字');
});
test('the same handler and store immediately use edited copy without reconnecting or changing game configuration', async () => {
	let templates: ReplyOverrides = {};
	const store = new BotStore(':memory:', () => templates);
	const handler = new CommandHandler(store, {} as any, { replyTemplates: () => templates });
	const group: GroupConfig = {
		groupId: '100',
		communityId: 'c',
		serverId: 'a',
		serverName: 'Alpha',
		timezone: 'Asia/Shanghai',
		checkinPoints: 10,
		moveCost: 3,
		moveCooldownSeconds: 300,
		factions: { 蓝: 'Blue', 红: 'Red', 绿: 'Green' }
	};
	const send = (text: string) =>
		handler.handle({ id: text, groupId: '100', userId: '200', text, time: Date.now() }, group);
	try {
		expect(await send('/帮助')).toStartWith('Alpha · 自助服务');
		templates = validateReplies({
			'help.title': '欢迎来到 {serverName}',
			'bind.required': '请先绑定'
		});
		expect(await send('/帮助')).toStartWith('欢迎来到 Alpha');
		templates = validateReplies({ 'help.commands': '/帮助 自定义说明' });
		expect(await send('/帮助')).toContain('/帮助 自定义说明');
		templates = validateReplies({ 'bind.required': '请先绑定' });
		expect(await send('/签到')).toBe('请先绑定');
		store.beginBinding('c', '200', '76561198000000001', '123456', Date.now());
		expect(() => store.verifyBinding('c', '200', '765432', Date.now())).toThrow('验证码不正确');
		templates = validateReplies({ 'bind.wrong': '还可尝试 {remaining} 次' });
		expect(() => store.verifyBinding('c', '200', '765432', Date.now())).toThrow('还可尝试 3 次');
	} finally {
		store.close();
	}
});
