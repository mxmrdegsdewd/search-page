// whisper-worker.js — Whisper speech recognition in browser via Transformers.js

let transcriber = null;

self.onmessage = async function(e) {
    if (e.data.type === 'load') {
        try {
            self.postMessage({type:'status', msg:'Загрузка...'});
            const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3');
            env.allowLocalModels = false;

            var useWebGPU = false;
            try { if (typeof navigator !== 'undefined' && navigator.gpu) { await navigator.gpu.requestAdapter(); useWebGPU = true; } } catch(e) {}

            self.postMessage({type:'status', msg:'Модель ' + (useWebGPU ? '(WebGPU)' : '') + '...'});
            transcriber = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny', {
                dtype: useWebGPU ? 'fp32' : 'q8',
                device: useWebGPU ? 'webgpu' : 'wasm',
                progress_callback: function(p) {
                    if (p.status === 'progress' && p.total) {
                        self.postMessage({type:'progress', pct: Math.round(p.loaded / p.total * 100)});
                    }
                }
            });
            self.postMessage({type:'ready'});
        } catch(err) {
            self.postMessage({type:'error', msg:'Ошибка: ' + err.message});
        }
    }

    if (e.data.type === 'transcribe') {
        if (!transcriber) { self.postMessage({type:'error', msg:'Модель не загружена', id:e.data.id}); return; }
        try {
            var t0 = performance.now();
            var result = await transcriber(e.data.audio, {
                language: 'russian',
                task: 'transcribe',
                chunk_length_s: 30,
                stride_length_s: 5,
            });
            self.postMessage({type:'result', text: (result.text || '').trim(), id: e.data.id, ms: Math.round(performance.now() - t0)});
        } catch(err) {
            self.postMessage({type:'error', msg: err.message, id: e.data.id});
        }
    }
};
