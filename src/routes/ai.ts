import { Router } from 'express';
import { GoogleGenAI, Type } from '@google/genai';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { requireDb } from '../middleware/db.js';
import { AppSettingsModel } from '../models/AppSettings.js';

export const aiRouter = Router();

aiRouter.use(requireAuth);
aiRouter.use(requireDb);

/** POST /api/ai/generate-insight — generate GDC Assistant insight using Gemini key from MongoDB */
aiRouter.post('/generate-insight', async (req: AuthedRequest, res, next) => {
  try {
    const { metrics = [], employeeData = [], context } = req.body || {};
    const doc = await AppSettingsModel.findOne({ key: 'default' }).lean();
    const dbKey = (doc as any)?.geminiApiKey && String((doc as any).geminiApiKey).trim();
    const apiKey = dbKey || (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) || '';
    if (!apiKey) {
      return res.status(200).json({
        summary: 'GDC Assistant needs a Gemini API key to run.',
        recommendation:
          'Go to Settings → AI Integration, add your Google Gemini API key (stored in the database), then try again.'
      });
    }
    const role = context?.viewerRole ?? 'admin';
    const scopeBranches = context?.viewerBranches ?? (context?.viewerBranch ? [context.viewerBranch] : []);
    const performanceByBranch = context?.performanceByBranch ?? [];
    const inScope =
      scopeBranches.length === 0
        ? performanceByBranch
        : performanceByBranch.filter(
            (b: any) => scopeBranches.includes(b.branchId) || scopeBranches.includes(b.branchName)
          );
    const taskCounts = context?.taskCounts ?? { total: 0, done: 0, overdue: 0, inProgress: 0 };
    const behaviorByUser = context?.behaviorCountByUserId ?? {};
    const scopeLabel =
      role === 'super-admin'
        ? 'Organization-wide (all branches)'
        : role === 'team-lead'
          ? `Your team(s): ${(inScope.map((b: any) => b.branchName).join(', ') || '—')}`
          : `Branch: ${inScope[0]?.branchName ?? context?.viewerBranch ?? '—'}`;
    const prompt = `
You are "GDC Assistant", a helpful bot for performance and attendance analysis.
The viewer is: **${context?.viewerName ?? 'Manager'}** (${role}). Scope: ${scopeLabel}.

**Data to analyze (only within the scope above):**
- Performance by branch: ${JSON.stringify(inScope)}
- Per-person today: status (checked-in / idle / lunch-break / tea-break / offline), workMinutes, idleMinutes, tasks (weekly), isLate.
- Key metrics: ${JSON.stringify(metrics)}
- Task counts (org/branch): total=${taskCounts.total}, done=${taskCounts.done}, overdue=${taskCounts.overdue}, in-progress=${taskCounts.inProgress}.
- Behavior incidents by user (count): ${JSON.stringify(behaviorByUser)}

**Your job:**
1. **Attendance:** Who is late today? Who is offline vs checked-in? Any patterns by branch?
2. **Idle time:** Who has high idle minutes? Any concerns?
3. **Performance:** Task completion by person and by branch; who is ahead/behind?
4. **Breaks:** Anyone on long lunch/tea? Within policy?
5. **Workload:** Overdue and in-progress tasks; balance across team/branches.
6. **Behavior:** If any behavior counts exist, note briefly (no naming unless relevant to recommendation).

**Format:**
- **summary**: A clear, scoped status report (2–4 sentences or bullets). Mention specific names where useful. Cover attendance, performance, idle, breaks, and workload. For super-admin, compare branches briefly; for team-lead/admin, focus on their branch/team.
- **recommendation**: One or two concrete actions the viewer should take (e.g. follow up with X, review overdue tasks, address idle time).

Tone: Friendly, direct, professional. Plain English. No jargon.
`;
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            recommendation: { type: Type.STRING }
          },
          required: ['summary', 'recommendation']
        }
      }
    });
    const text = response.text;
    if (!text) return res.status(502).json({ error: 'No response from AI' });
    const result = JSON.parse(text);
    return res.json(result);
  } catch (e: any) {
    console.error('AI generate-insight error:', e);
    const msg = e?.message ?? String(e);
    const status = e?.status ?? e?.statusCode;
    const isAuth = status === 401 || status === 403 || /invalid.*api.*key|api key not valid|permission denied/i.test(msg);
    const isNetwork = /fetch|network|connection|refused|failed to fetch/i.test(msg);
    if (isAuth) {
      return res.status(200).json({
        summary: 'GDC Assistant could not authenticate with the AI service.',
        recommendation:
          'In Settings → AI Integration, check that the stored Gemini API key is correct and has access to the Gemini API.'
      });
    }
    if (isNetwork) {
      return res.status(200).json({
        summary: 'GDC Assistant could not reach the AI service.',
        recommendation: 'Check your internet connection and try again.'
      });
    }
    return res.status(200).json({
      summary: 'GDC Assistant is offline. Please try again later.',
      recommendation: msg && msg.length < 120 ? msg : 'Check internet connection and the API key in Settings → AI Integration.'
    });
  }
});
