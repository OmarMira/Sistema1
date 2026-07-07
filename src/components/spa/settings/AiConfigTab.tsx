import { useState, useEffect } from 'react';
import { useLanguageStore } from '@/store/language-store';
import { AI_CONFIG } from '@/lib/constants/ai-config';

export default function AiConfigTab() {
  const language = useLanguageStore((s) => s.language) || 'es';
  const t = useLanguageStore((s) => s.t);
  const isEn = language === 'en';

  const [apiKey, setApiKey] = useState('');
  const [selectedModel, setSelectedModel] = useState<string>(AI_CONFIG.DEFAULT_MODEL);
  const [customModel, setCustomModel] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [aiAlive, setAiAlive] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/config/ai')
      .then((res) => res.json())
      .then((data) => {
        if (data.isSaved) {
          setIsSaved(true);
          setAiAlive(data.aiAlive ?? false);
          if (data.apiKey) setApiKey(data.apiKey);
          if (data.model) {
            const isStandard = AI_CONFIG.AVAILABLE_MODELS.some((m) => m.id === data.model);
            if (isStandard) {
              setSelectedModel(data.model);
            } else {
              setSelectedModel('custom');
              setCustomModel(data.model);
            }
          }
        } else {
          setIsSaved(false);
          setAiAlive(false);
        }
      })
      .catch(() => {
        if (localStorage.getItem('ai_key_saved') === 'true') {
          setIsSaved(true);
          setAiAlive(null);
        }
      });
  }, []);

  const getActiveModel = () => {
    return selectedModel === 'custom' ? customModel : selectedModel;
  };

  const handleSave = async () => {
    setStatus('');
    setLoading(true);
    const model = getActiveModel();
    if (selectedModel === 'custom' && !customModel.trim()) {
      setStatus('❌ Por favor introduce el nombre del modelo personalizado.');
      setLoading(false);
      return;
    }
    try {
      // 1. Verificar primero
      const verifyRes = await fetch('/api/config/ai/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, model }),
      });
      const verifyData = await verifyRes.json();

      if (!verifyRes.ok && !verifyData.warning) {
        setStatus(`❌ ${t('aiAssistant.verificationFailed')}` + (verifyData.error || t('aiAssistant.invalidKeyNoSave')));
        setLoading(false);
        return;
      }

      // 2. Si verifica (o da warning de 429), guardar
      const res = await fetch('/api/config/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, model }),
      });
      const data = await res.json();
      if (res.ok) {
        localStorage.setItem('ai_key_saved', 'true');
        if (verifyData.warning) {
          setStatus(`⚠️ ${verifyData.warning}`);
        } else {
          setStatus(`✅ ${t('aiAssistant.configSaveSuccess')}`);
        }
        setIsSaved(true);
      } else {
        setStatus(`❌ ${t('aiAssistant.configSaveError')} ` + (data.error || ''));
      }
    } catch (e) {
      setStatus(`❌ ${t('aiAssistant.configNetworkError')}`);
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    setStatus('');
    setLoading(true);
    const model = getActiveModel();
    if (selectedModel === 'custom' && !customModel.trim()) {
      setStatus('❌ Por favor introduce el nombre del modelo personalizado.');
      setLoading(false);
      return;
    }
    try {
      const res = await fetch('/api/config/ai/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, model }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.warning) {
          setStatus(`⚠️ ${data.warning}`);
        } else {
          setStatus(`✅ ${t('aiAssistant.connectionSuccess')}`);
        }
      } else {
        setStatus(`❌ ${t('aiAssistant.verificationFailed')}` + (data.error || t('aiAssistant.invalidKey')));
      }
    } catch (e) {
      setStatus(`❌ ${t('aiAssistant.networkErrorVerify')}`);
    } finally {
      setLoading(false);
    }
  };

  if (isSaved) {
    if (aiAlive === null) {
      return (
        <div className="max-w-lg mx-auto bg-white rounded-xl shadow-md p-8 border border-gray-200 text-center">
          <div className="text-5xl mb-4 animate-pulse">🤖</div>
          <p className="text-gray-500 text-sm">
            {isEn ? 'Verificando conexión con IA...' : 'Verificando conexión con IA...'}
          </p>
        </div>
      );
    }

    if (aiAlive) {
      return (
        <div className="max-w-lg mx-auto bg-white rounded-xl shadow-md p-8 border border-green-200 text-center">
          <div className="text-5xl mb-4">🤖✨</div>
          <h2 className="text-2xl font-bold text-gray-800 mb-2">{t('aiAssistant.assistantActivated')}</h2>
          <p className="text-gray-600 mb-8">{t('aiAssistant.savedSuccessDesc')}</p>
          <button
            onClick={() => {
              setIsSaved(false);
              setStatus('');
            }}
            className="bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium px-6 py-2 rounded-lg transition-colors"
          >
            {t('aiAssistant.editSettings')}
          </button>
        </div>
      );
    }

    return (
      <div className="max-w-lg mx-auto bg-white rounded-xl shadow-md p-8 border border-red-200 text-center">
        <div className="text-5xl mb-4">⚠️</div>
        <h2 className="text-xl font-bold text-gray-800 mb-2">
          {isEn ? 'AI connection failed' : 'La conexión con IA falló'}
        </h2>
        <p className="text-gray-600 mb-4 text-sm">
          {isEn
            ? 'The API key is saved but the AI is not responding. Check your configuration below.'
            : 'La clave API está guardada pero la IA no responde. Verificá tu configuración abajo.'}
        </p>
        <button
          onClick={() => {
            setIsSaved(false);
            setStatus('');
          }}
          className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-6 py-2 rounded-lg transition-colors"
        >
          {t('aiAssistant.editSettings')}
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto bg-white rounded-xl shadow-md p-6 border border-gray-100">
      <h2 className="text-2xl font-bold text-gray-800 mb-2 flex items-center gap-2">
        <span>🤖</span> {t('aiAssistant.configTitle')}
      </h2>
      <p className="text-sm text-gray-600 mb-6">{t('aiAssistant.configDescription')}</p>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Columna Izquierda: Recomendación + Paso 1 */}
        <div className="lg:col-span-7 space-y-6">
          {/* Banner de modelo sugerido */}
          <div className="p-4 bg-amber-50 border border-amber-200 text-amber-900 rounded-lg text-xs">
            <div className="font-semibold text-sm flex items-center gap-1.5 mb-1 text-amber-950">
              <span>💡</span>{' '}
              {isEn ? 'Recommended Model (100% Free)' : 'Modelo Recomendado (100% Gratis)'}
            </div>
            <p className="mb-2 leading-relaxed">
                {isEn
                  ? 'We suggest using OpenRouter configured with the free router '
                  : 'Te sugerimos usar OpenRouter configurado con el enrutador gratuito '}
              <code className="bg-amber-100 font-mono text-[11px] px-1.5 py-0.5 rounded border border-amber-300 select-all font-semibold">
                {AI_CONFIG.DEFAULT_MODEL}
              </code>
              .
            </p>
            <p className="leading-relaxed">
              {isEn
                ? 'For a 100% free experience, use this router as OpenRouter rotates free models over time. If you prefer Qwen 2.5/3.7, you can select them in Step 2, but they require a paid key (extremely cheap, cents per million tokens).'
                : 'Para una experiencia 100% gratis usá este enrutador, ya que OpenRouter rota los modelos gratis con el tiempo. Si preferís Qwen 2.5/3.7, podés seleccionarlos en el Paso 2, pero requieren una clave con saldo (es extremadamente barato, centavos por millón de tokens).'}
            </p>
          </div>

          {/* Paso 1 */}
          <div className="p-4 bg-blue-50/50 rounded-lg border border-blue-100">
            <h3 className="font-semibold text-blue-900 mb-2 flex items-center gap-2">
              <span className="bg-blue-600 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs font-bold">
                1
              </span>
              {t('aiAssistant.step1Title')}
            </h3>

            <div className="text-xs text-blue-800/80 space-y-2 mb-4 leading-relaxed">
              <p>
                {isEn
                  ? "Click the button below to open OpenRouter. If you don't have an account, register first (it takes 1 minute)."
                  : 'Hacé clic en el botón de abajo para abrir OpenRouter. Si no tenés cuenta, registrate primero (lleva 1 minuto).'}
              </p>
              <div className="p-3 bg-white/70 border border-blue-100 rounded-md text-[11px] space-y-2 font-medium text-blue-950">
                <div className="font-bold text-blue-900 mb-1">
                  {isEn
                    ? 'Once on the OpenRouter page:'
                    : 'Una vez dentro de la página de OpenRouter:'}
                </div>
                <div className="flex gap-1.5 items-start">
                  <span className="text-blue-600 font-bold">1.</span>
                  <span>
                    {isEn ? 'Click the blue button ' : 'Hacé clic en el botón azul '}
                    <strong className="bg-blue-600 text-white px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap font-bold shadow-sm">
                      + New Key
                    </strong>
                    {isEn ? ' at the top right.' : ' arriba a la derecha.'}
                  </span>
                </div>
                <div className="flex gap-1.5 items-start">
                  <span className="text-blue-600 font-bold">2.</span>
                  <span>
                    {isEn
                      ? 'Enter a name (e.g. "My Assistant") and click '
                      : 'Poné un nombre (ej. "Mi Asistente") y hacé clic en '}
                    <strong className="bg-blue-50 border border-blue-200 px-1 py-0.5 rounded text-[10px] text-blue-800 font-bold">
                      Create
                    </strong>
                    .
                  </span>
                </div>
                <div className="flex gap-1.5 items-start">
                  <span className="text-blue-600 font-bold">3.</span>
                  <span>
                    {isEn
                      ? 'Copy the generated key (starts with '
                      : 'Copiá la clave generada (empieza con '}
                    <code className="bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded font-mono text-[10px] text-amber-900 font-semibold select-all">
                      sk-or-v1-...
                    </code>
                    {isEn ? ') and paste it in Step 3 below.' : ') y pegala en el Paso 3 de abajo.'}
                  </span>
                </div>
              </div>
            </div>

            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-4 py-2 rounded shadow-sm transition-colors"
            >
              {t('aiAssistant.createKeyOpenRouter')}
            </a>
          </div>
        </div>

        {/* Columna Derecha: Paso 2 (Modelo) + Paso 3 (API Key) + Paso 4 (Prueba/Activa) */}
        <div className="lg:col-span-5 flex flex-col justify-between space-y-6">
          {/* Paso 2: Selección de modelo */}
          <div className="p-4 bg-gray-50 rounded-lg border border-gray-200 flex-1 flex flex-col justify-between">
            <div>
              <h3 className="font-semibold text-gray-800 mb-1 flex items-center gap-2">
                <span className="bg-gray-600 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs font-bold">
                  2
                </span>
                {t('aiAssistant.step3Title')}
              </h3>
              <p className="text-xs text-gray-500 mb-3">{t('aiAssistant.step3Desc')}</p>
            </div>

            <div className="space-y-3 mt-auto">
              <select
                className="w-full p-2.5 border border-gray-300 rounded bg-white text-black focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm font-medium"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
              >
                {AI_CONFIG.AVAILABLE_MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>

              {selectedModel === 'custom' && (
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block">
                    {isEn ? 'Custom Model Identifier' : 'Identificador de Modelo Personalizado'}
                  </label>
                  <input
                    type="text"
                    className="w-full p-2 border border-gray-300 rounded bg-white text-black focus:ring-2 focus:ring-blue-500 focus:border-transparent text-xs font-mono"
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    placeholder="e.g. deepseek/deepseek-chat"
                  />
                  <p className="text-[10px] text-gray-400 leading-normal">
                    {isEn
                      ? 'Type the exact model ID from OpenRouter models directory.'
                      : 'Escribí el ID exacto del modelo desde el directorio de modelos de OpenRouter.'}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Paso 3 */}
          <div className="p-4 bg-gray-50 rounded-lg border border-gray-200 flex-1 flex flex-col justify-between">
            <div>
              <h3 className="font-semibold text-gray-800 mb-1 flex items-center gap-2">
                <span className="bg-gray-600 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs font-bold">
                  3
                </span>
                {t('aiAssistant.step2Title')}
              </h3>
              <p className="text-xs text-gray-500 mb-3">{t('aiAssistant.step2Desc')}</p>
            </div>
            <div className="relative mt-auto">
              <input
                type={showKey ? 'text' : 'password'}
                className="w-full p-2.5 pr-20 border border-gray-300 rounded bg-white text-black focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-or-v1-..."
              />
              <button
                type="button"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-medium text-gray-700 hover:text-gray-900 bg-gray-200 hover:bg-gray-300 px-2 py-1 rounded transition-colors"
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? t('aiAssistant.hide') : t('aiAssistant.show')}
              </button>
            </div>
          </div>

          {/* Paso 4 */}
          <div className="p-4 bg-gray-50 rounded-lg border border-gray-200 flex-1 flex flex-col justify-between">
            <div>
              <h3 className="font-semibold text-gray-800 mb-1 flex items-center gap-2">
                <span className="bg-gray-600 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs font-bold">
                  4
                </span>
                {t('aiAssistant.step4Title')}
              </h3>
              <p className="text-xs text-gray-500 mb-4">{t('aiAssistant.step4Desc')}</p>
            </div>
            <div className="flex gap-3 mt-auto">
              <button
                disabled={loading || !apiKey}
                className="flex-1 bg-gray-200 hover:bg-gray-300 disabled:opacity-50 text-gray-700 text-sm font-medium px-4 py-2.5 rounded transition-colors"
                onClick={handleVerify}
              >
                {t('aiAssistant.verifyConnection')}
              </button>
              <button
                disabled={loading || !apiKey}
                className="flex-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2.5 rounded transition-colors"
                onClick={handleSave}
              >
                {t('aiAssistant.saveAndActivate')}
              </button>
            </div>
          </div>

          {status && (
            <div
              className={`p-3 rounded-lg text-sm font-medium border ${
                status.includes('✅')
                  ? 'bg-green-50 border-green-200 text-green-800'
                  : status.includes('⚠️')
                    ? 'bg-yellow-50 border-yellow-200 text-yellow-800'
                    : 'bg-red-50 border-red-200 text-red-800'
              }`}
            >
              {status}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
