import { useState, useEffect } from 'react';
import { useLanguageStore } from '@/store/language-store';
import { AI_PROVIDERS, type ProviderId } from '@/lib/constants/ai-config';

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
    <div className="max-w-lg mx-auto bg-white rounded-xl shadow-md p-6 border border-gray-100">
      <h2 className="text-xl font-bold text-gray-800 mb-1 flex items-center gap-2">
        <span>🤖</span> {t('aiAssistant.configTitle')}
      </h2>
      <p className="text-sm text-gray-500 mb-6">{t('aiAssistant.configDescription')}</p>

      <div className="space-y-5">
        {/* Proveedor */}
        <div>
          <label className="text-xs font-bold text-gray-600 uppercase tracking-wider block mb-1.5">
            {isEn ? 'AI Provider' : 'Proveedor de IA'}
          </label>
          <select
            className="w-full p-2.5 border border-gray-300 rounded-lg bg-white text-black focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value as ProviderId)}
          >
            {AI_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        {/* Campos custom (solo si "Otro proveedor") */}
        {isCustom && (
          <>
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
                placeholder="ej. gpt-4o, claude-sonnet, deepseek-chat"
              />
            </div>
          </>
        )}

        {/* API Key */}
        <div>
          <label className="text-xs font-bold text-gray-600 uppercase tracking-wider block mb-1.5">
            {isEn ? 'API Key' : 'Clave de API'}
          </label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              className="w-full p-2.5 pr-16 border border-gray-300 rounded-lg bg-white text-black focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm font-mono"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
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
        <div className="flex gap-3 pt-2">
          <button
            disabled={loading || !apiKey}
            className="flex-1 bg-gray-100 hover:bg-gray-200 disabled:opacity-50 text-gray-700 text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
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
  );
}
