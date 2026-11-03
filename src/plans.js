// Plans, limits and account helpers. Prices shown here are display-only:
// the real charge comes from the Stripe Price IDs in env.
const db = require('./db');

const PLANS = {
  solo: { key: 'solo', name: 'Solo', seats: 1, texts: Number(process.env.SOLO_TEXTS || 150), month: '£14.99', year: '£149',
    blurb: 'For sole traders', perks: ['Your own We Missed You number', '150 texts a month', 'SMS or WhatsApp', 'Keep your number or get a business line'] },
  team: { key: 'team', name: 'Team', seats: 5, texts: Number(process.env.TEAM_TEXTS || 400), month: '£39', year: '£390',
    blurb: 'For firms with a crew', perks: ['Up to 5 people, each with a number', '400 texts a month, shared', 'See the whole team’s missed calls', 'Extra people £6/month'] },
};
const SEAT = { month: '£6', year: '£60', texts: Number(process.env.SEAT_TEXTS || 80) };
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 7);

/** The billing account a user belongs to (themselves if they're an owner). */
const ownerOf = (user) => (user.team_owner_id ? db.userById(user.team_owner_id) : user);

function planOf(owner) {
  const p = PLANS[owner.plan] || PLANS.solo;
  const extra = p.key === 'team' ? owner.extra_seats || 0 : 0;
  return { ...p, seats: p.seats + extra, texts: p.texts + extra * SEAT.texts, extra };
}

function usage(owner) {
  const plan = planOf(owner);
  const used = db.sentThisMonth(db.teamIds(owner.id));
  return { used, limit: plan.texts, pct: Math.min(100, Math.round((used / plan.texts) * 100)), left: Math.max(0, plan.texts - used) };
}

module.exports = { PLANS, SEAT, TRIAL_DAYS, ownerOf, planOf, usage };
