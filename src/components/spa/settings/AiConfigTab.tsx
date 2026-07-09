import { useState, useEffect } from 'react';
import { useLanguageStore } from '@/store/language-store';
import { AI_PROVIDERS, type ProviderId } from '@/lib/constants/ai-config';

const PROVIDER_INSTRUCTIONS: Record<ProviderId, { steps: string[]; link: string; linkLabel: string; keyHint: string }> = {
  openrouter: {
    steps: [
      'Registrate en openrouter.ai (es gratis, lleva 1 minuto)',
      'Hacé clic en "+ New Key" arriba a la derecha',
      'Poné un nombre (ej. "Mi Asistente") y hacé clic en Create',
      'Copiá la clave generada (empieza con sk-or-v1-...)',
    ],
    link: 'https://openrouter.ai/keys',
    linkLabel: 'Abrir OpenRouter',
    keyHint: 'sk-or-v1-...',
  },
  deepseek: {
    steps: [
      'Registrate en platform.deepseek.com',
      'Andá a API Keys y hacé clic en "Create new key"',
      'Copiá la clave generada',
    ],
    link: 'https://platform.deepseek.com/api_keys',
    linkLabel: 'Abrir DeepSeek',
    keyHint: 'sk-...',
  },
  anthropic: {
    steps: [
      'Registrate en console.anthropic.com',
      'Andá a API Keys y hacé clic en "Create Key"',
      'Copiá la clave generada',
    ],
    link: 'https://console.anthropic.com/settings/keys',
    linkLabel: 'Abrir Anthropic',
    keyHint: 'sk-ant-...',
  },
  openai: {
    steps: [
      'Registrate en platform.openai.com',
      'Andá a API Keys y hacé clic en "Create new secret key"',
      'Copiá la clave generada',
    ],
    link: 'https://platform.openai.com/api-keys',
    linkLabel: 'Abrir OpenAI',
    keyHint: 'sk-...',
  },
  google: {
    steps: [
      'Andá a aistudio.google.com',
      'Hacé clic en "Get API key" y creá una clave',
      'Copiá la clave generada',
    ],
    link: 'https://aistudio.google.com/apikey',
    linkLabel: 'Abrir Google AI Studio',
    keyHint: 'AIza...',
  },
  custom: {
    steps: [],
    link: '',
    linkLabel: '',
    keyHint: 'sk-...',
  },
};

export default function AiConfigTab() {
  const language = useLanguageStore((s) => s.language) || 'es';
  const t = useLanguageStore((s) => s.t);
  const isEn = language === 'en';

  const [provider, setProvider] = useState<ProviderId>('openrouter');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [aiAlive, setAiAlive] = useState<boolean | null>(null);

  const isCustom = provider === 'custom';
  const activeModel = isCustom ? customModel : model;
  const activeBaseUrl = isCustom ? customBaseUrl : baseUrl;
  const instructions = PROVIDER_INSTRUCTIONS[provider];

  useEffect(() => {
    fetch('/api/config/ai')
      .then((res) => res.json())
      .then((data) => {
        if (data.isSaved) {
          setIsSaved(true);
          setAiAlive(data.aiAlive ?? false);
          if (data.apiKey) setApiKey(data.apiKey);
          if (data.baseUrl) {
            const matched = AI_PROVIDERS.find((p) => p.baseUrl === data.baseUrl && p.id !== 'custom');
            if (matched) {
              setProvider(matched.id);
              setBaseUrl(matched.baseUrl);
              setModel(matched.defaultModel);
            } else {
              setProvider('custom');
              setCustomBaseUrl(data.baseUrl);
            }
          }
          if (data.model) {
            const matched = AI_PROVIDERS.find((p) => p.defaultModel === data.model && p.id !== 'custom');
            if (matched) {
              setModel(matched.defaultModel);
            } else {
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

  const handleProviderChange = (id: ProviderId) => {
    setProvider(id);
    const p = AI_PROVIDERS.find((x) => x.id === id);
    if (p && p.id !== 'custom') {
      setBaseUrl(p.baseUrl);
      setModel(p.defaultModel);
    }
  };

  const handleSave = async () => {
    setStatus('');
    setLoading(true);

    if (!apiKey.trim()) {
      setStatus('❌ Ingresá tu clave de API.');
      setLoading(false);
      return;
    }
    if (isCustom && !customModel.trim()) {
      setStatus('❌ Ingresá el ID del modelo.');
      setLoading(false);
      return;
    }
    if (isCustom && !customBaseUrl.trim()) {
      setStatus('❌ Ingresá la URL base de la API.');
      setLoading(false);
      return;
    }

    try {
      const verifyRes = await fetch('/api/config/ai/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, model: activeModel, baseUrl: activeBaseUrl }),
      });
      const verifyData = await verifyRes.json();

      if (!verifyRes.ok && !verifyData.warning) {
        setStatus(`❌ ${t('aiAssistant.verificationFailed')}` + (verifyData.error || t('aiAssistant.invalidKeyNoSave')));
        setLoading(false);
        return;
      }

      const res = await fetch('/api/config/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, model: activeModel, baseUrl: activeBaseUrl }),
      });
      const data = await res.json();
      if (res.ok) {
        localStorage.setItem('ai_key_saved', 'true');
        setStatus(verifyData.warning
          ? `⚠️ ${verifyData.warning}`
          : `✅ ${t('aiAssistant.configSaveSuccess')}`);
        setIsSaved(true);
      } else {
        setStatus(`❌ ${t('aiAssistant.configSaveError')} ` + (data.error || ''));
      }
    } catch {
      setStatus(`❌ ${t('aiAssistant.configNetworkError')}`);
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    setStatus('');
    setLoading(true);

    if (!apiKey.trim()) {
      setStatus('❌ Ingresá tu clave de API.');
      setLoading(false);
      return;
    }

    try {
      const res = await fetch('/api/config/ai/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, model: activeModel, baseUrl: activeBaseUrl }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus(data.warning ? `⚠️ ${data.warning}` : `✅ ${t('aiAssistant.connectionSuccess')}`);
      } else {
        setStatus(`❌ ${t('aiAssistant.verificationFailed')}` + (data.error || t('aiAssistant.invalidKey')));
      }
    } catch {
      setStatus(`❌ ${t('aiAssistant.networkErrorVerify')}`);
    } finally {
      setLoading(false);
    }
  };

  if (isSaved) {
    if (aiAlive === null) {
      return (
        <div className="max-w-md mx-auto bg-white rounded-xl shadow-md p-8 border border-gray-200 text-center">
          <div className="text-5xl mb-4 animate-pulse">🤖</div>
          <p className="text-gray-500 text-sm">
            {isEn ? 'Verifying AI connection...' : 'Verificando conexión con IA...'}
          </p>
        </div>
      );
    }

    if (aiAlive) {
      return (
        <div className="max-w-md mx-auto bg-white rounded-xl shadow-md p-8 border border-green-200 text-center">
          <div className="text-5xl mb-4">🤖✨</div>
          <h2 className="text-2xl font-bold text-gray-800 mb-2">{t('aiAssistant.assistantActivated')}</h2>
          <p className="text-gray-600 mb-8">{t('aiAssistant.savedSuccessDesc')}</p>
          <button
            onClick={() => { setIsSaved(false); setStatus(''); }}
            className="bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium px-6 py-2 rounded-lg transition-colors"
          >
            {t('aiAssistant.editSettings')}
          </button>
        </div>
      );
    }

    return (
      <div className="max-w-md mx-auto bg-white rounded-xl shadow-md p-8 border border-red-200 text-center">
        <div className="text-5xl mb-4">⚠️</div>
        <h2 className="text-xl font-bold text-gray-800 mb-2">
          {isEn ? 'AI connection failed' : 'La conexión con IA falló'}
        </h2>
        <p className="text-gray-600 mb-4 text-sm">
          {isEn
            ? 'The API key is saved but the AI is not responding. Check your configuration below.'
            : 'La clave está guardada pero la IA no responde. Verificá tu configuración abajo.'}
        </p>
        <button
          onClick={() => { setIsSaved(false); setStatus(''); }}
          className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-6 py-2 rounded-lg transition-colors"
        >
          {t('aiAssistant.editSettings')}
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto bg-white rounded-xl shadow-md p-6 border border-gray-100">
      <h2 className="text-2xl font-bold text-gray-800 mb-1 flex items-center gap-2">
        <span>🤖</span> {t('aiAssistant.configTitle')}
      </h2>
      <p className="text-sm text-gray-500 mb-6">{t('aiAssistant.configDescription')}</p>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Columna izquierda: Instrucciones del proveedor */}
        <div className="lg:col-span-7 space-y-5">
          {/* Proveedor */}
          <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
            <label className="text-xs font-bold text-gray-600 uppercase tracking-wider block mb-1.5">
              {isEn ? 'Step 1: Choose your AI provider' : 'Paso 1: Elegí tu proveedor de IA'}
            </label>
            <select
              className="w-full p-2.5 border border-gray-300 rounded-lg bg-white text-black focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm font-medium"
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value as ProviderId)}
            >
              {AI_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Instrucciones paso a paso */}
          {!isCustom && instructions.steps.length > 0 && (
            <div className="p-4 bg-blue-50/50 rounded-lg border border-blue-100">
              <h3 className="font-semibold text-blue-900 mb-2 text-sm">
                {isEn ? 'How to get your API key' : 'Cómo obtener tu clave de API'}
              </h3>
              <ol className="text-xs text-blue-800/80 space-y-1.5 mb-4 leading-relaxed list-decimal list-inside">
                {instructions.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
              <a
                href={instructions.link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-4 py-2 rounded shadow-sm transition-colors"
              >
                {instructions.linkLabel} ↗
              </a>
            </div>
          )}

          {/* Info del modelo seleccionado */}
          {!isCustom && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
              <strong>{isEn ? 'Model:' : 'Modelo:'}</strong> {model}
              {provider === 'openrouter' && (
                <span className="block mt-1 text-amber-600">
                  {isEn
                    ? 'OpenRouter routes to the best free model available.'
                    : 'OpenRouter enruta automáticamente al mejor modelo gratuito disponible.'}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Columna derecha: Key + Botones */}
        <div className="lg:col-span-5 flex flex-col justify-between space-y-5">
          {/* Campos custom */}
          {isCustom && (
            <div className="p-4 bg-gray-50 rounded-lg border border-gray-200 space-y-3">
              <div>
                <label className="text-xs font-bold text-gray-600 uppercase tracking-wider block mb-1.5">
                  {isEn ? 'Base URL' : 'URL Base'}
                </label>
                <input
                  type="text"
                  className="w-full p-2.5 border border-gray-300 rounded-lg bg-white text-black focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm font-mono"
                  value={customBaseUrl}
                  onChange={(e) => setCustomBaseUrl(e.target.value)}
                  placeholder="https://api.ejemplo.com/v1"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-gray-600 uppercase tracking-wider block mb-1.5">
                  {isEn ? 'Model ID' : 'ID del Modelo'}
                </label>
                <input
                  type="text"
                  className="w-full p-2.5 border border-gray-300 rounded-lg bg-white text-black focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm font-mono"
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  placeholder="ej. gpt-4o, claude-sonnet"
                />
              </div>
            </div>
          )}

          {/* API Key */}
          <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
            <label className="text-xs font-bold text-gray-600 uppercase tracking-wider block mb-1.5">
              {isEn ? 'Step 2: Paste your API key' : 'Paso 2: Pegá tu clave de API'}
            </label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                className="w-full p-2.5 pr-16 border border-gray-300 rounded-lg bg-white text-black focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm font-mono"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={instructions.keyHint}
              />
              <button
                type="button"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-medium text-gray-600 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded transition-colors"
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? t('aiAssistant.hide') : t('aiAssistant.show')}
              </button>
            </div>
          </div>

          {/* Botones */}
          <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
            <label className="text-xs font-bold text-gray-600 uppercase tracking-wider block mb-3">
              {isEn ? 'Step 3: Verify and activate' : 'Paso 3: Verificá y activá'}
            </label>
            <div className="flex gap-3">
              <button
                disabled={loading || !apiKey}
                className="flex-1 bg-gray-200 hover:bg-gray-300 disabled:opacity-50 text-gray-700 text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
                onClick={handleVerify}
              >
                {t('aiAssistant.verifyConnection')}
              </button>
              <button
                disabled={loading || !apiKey}
                className="flex-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
                onClick={handleSave}
              >
                {t('aiAssistant.saveAndActivate')}
              </button>
            </div>
          </div>

          {/* Status */}
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
