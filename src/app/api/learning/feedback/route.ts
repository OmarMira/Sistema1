import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { recordFeedback } from '@/lib/learning/adaptive-engine';
import { requireCompanyContext } from '@/lib/context-storage';
import { learningFeedbackSchema } from '@/lib/validations/learning-feedback';

export const PATCH = apiHandler(async (req: NextRequest) => {
  const { userId, companyId } = requireCompanyContext();

  const body = await req.json();
  const parsed = learningFeedbackSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { bankDescription, glAccountCode, role, source } = parsed.data;
  const { confidence } = body;

  await recordFeedback({
    timestamp: new Date().toISOString(),
    bankDescription,
    selectedGlAccountCode: glAccountCode,
    confidence: confidence ?? 1.0,
    userId,
    companyId,
  });

  return NextResponse.json({
    success: true,
    message: 'Feedback registrado para entrenamiento local',
  });
});
