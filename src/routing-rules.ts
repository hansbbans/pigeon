interface RoutingRule {
	match_field: string;
	match_type: string;
	match_pattern: string;
	target_feed_key: string;
	target_display_name: string | null;
}

interface EmailContext {
	subject: string;
	fromName: string | undefined;
	fromAddress: string;
}

interface RoutingOverride {
	feedKey: string;
	displayName: string | null;
}

function matchValue(value: string, type: string, pattern: string): boolean {
	const v = value.toLowerCase();
	switch (type) {
		case 'contains':
			return v.includes(pattern.toLowerCase());
		case 'starts_with':
			return v.startsWith(pattern.toLowerCase());
		case 'ends_with':
			return v.endsWith(pattern.toLowerCase());
		case 'regex':
			try {
				return new RegExp(pattern, 'i').test(value);
			} catch {
				return false;
			}
		default:
			return false;
	}
}

export async function applyRoutingRules(
	db: D1Database,
	sourceFeedKey: string,
	ctx: EmailContext,
): Promise<RoutingOverride | null> {
	const { results } = await db
		.prepare(
			`SELECT match_field, match_type, match_pattern, target_feed_key, target_display_name
			 FROM routing_rules
			 WHERE source_feed_key = ? AND is_active = 1
			 ORDER BY priority DESC`,
		)
		.bind(sourceFeedKey)
		.all<RoutingRule>();

	for (const rule of results) {
		let fieldValue: string;
		switch (rule.match_field) {
			case 'subject':
				fieldValue = ctx.subject;
				break;
			case 'from_name':
				fieldValue = ctx.fromName || '';
				break;
			case 'from_email':
				fieldValue = ctx.fromAddress;
				break;
			default:
				continue;
		}

		if (matchValue(fieldValue, rule.match_type, rule.match_pattern)) {
			return {
				feedKey: rule.target_feed_key,
				displayName: rule.target_display_name,
			};
		}
	}

	return null;
}
