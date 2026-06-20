/*
 * Типограф страницы поиска.
 *
 * Архитектура: мощный движок русской типографики `typograf` (MIT,
 * https://github.com/typograf/typograf) делает всю основную работу —
 * неразрывные пробелы, тире, ёлочки, аббревиатуры, частицы, числа, символы.
 * Сверху — тонкий слой наших правил, которых в библиотеке нет:
 *   PRE  (до движка):  безопасные опечатки, латиница→кириллица, аббревиатуры, валюта.
 *   POST (после движка): капитализация, бренды, eLama, неразрывный дефис.
 *
 * URL и e-mail маскируются на всё время обработки, чтобы ни одно правило их не тронуло.
 *
 * Точка входа: window.typografText(text) -> String
 */
(function (global) {
    'use strict';

    var NBSP = ' '; // обычный неразрывный пробел
    var NBH  = '‑'; // неразрывный дефис

    /* ── Движок библиотеки (создаётся один раз, лениво) ── */
    var engine = null;
    function getEngine() {
        if (engine) return engine;
        if (typeof global.Typograf === 'undefined') return null;
        var tp = new global.Typograf({ locale: ['ru', 'en-US'] });
        // Мы обрабатываем простой текст, а не HTML: не экранировать & < >
        tp.disableRule('common/html/escape');
        // Группировка разрядов больших чисел: 100000 → 100 000
        tp.enableRule('common/number/digitGrouping');
        // Неразрывный пробел между числом и единицей: 5 кг → 5 кг
        tp.enableRule('common/nbsp/afterNumber');
        // Висячая пунктуация добавляет разметку — не нужна в простом тексте
        tp.disableRule('ru/optalign/*');
        engine = tp;
        return tp;
    }

    /* ── Защита URL / e-mail ── */
    function mask(text, store) {
        return text.replace(
            /(https?:\/\/\S+|ftp:\/\/\S+|www\.\S+|[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g,
            function (m) { store.push(m); return 'WTOKEN' + (store.length - 1) + 'WTOKEN'; }
        );
    }
    function unmask(text, store) {
        return text.replace(/WTOKEN(\d+)WTOKEN/g, function (m, i) { return store[+i]; });
    }

    /* ── PRE: безопасные орфографические правки (очевидные опечатки) ── */
    // Пары пишутся в обычном виде; неразрывные пробелы расставит движок.
    var TYPOS = [
        ['вообщем', 'в общем'], ['вобщем', 'в общем'],
        ['всмысле', 'в смысле'], ['впринципе', 'в принципе'],
        ['вкурсе', 'в курсе'], ['вцелом', 'в целом'], ['поидее', 'по идее'],
        ['врятли', 'вряд ли'], ['врядли', 'вряд ли'],
        ['наврятли', 'навряд ли'], ['наврядли', 'навряд ли'],
        ['типо', 'типа'], ['придти', 'прийти'],
        ['попрежнему', 'по-прежнему'], ['поновому', 'по-новому'],
        ['постарому', 'по-старому'], ['подругому', 'по-другому'],
        ['посвоему', 'по-своему'], ['порусски', 'по-русски'],
        ['поанглийски', 'по-английски'], ['понемецки', 'по-немецки'],
        ['помоему', 'по-моему'], ['потвоему', 'по-твоему'],
        ['понашему', 'по-нашему'], ['повашему', 'по-вашему'],
        ['понастоящему', 'по-настоящему'], ['похорошему', 'по-хорошему'],
        ['побыстрому', 'по-быстрому'], ['потихому', 'по-тихому'],
        ['повидимому', 'по-видимому'], ['полюбому', 'по-любому'],
        ['повсякому', 'по-всякому'], ['попростому', 'по-простому'],
        ['вопервых', 'во-первых'], ['вовторых', 'во-вторых'],
        ['втретьих', 'в-третьих']
    ];

    function fixTypos(t) {
        TYPOS.forEach(function (p) {
            t = t.replace(new RegExp('(?<![а-яёА-ЯЁ])' + p[0] + '(?![а-яёА-ЯЁ])', 'gi'), function (m) {
                // сохраняем заглавную первую букву исходного слова
                return /^[А-ЯЁ]/.test(m) ? p[1].charAt(0).toUpperCase() + p[1].slice(1) : p[1];
            });
        });
        return t;
    }

    /* ── PRE: латиница → кириллица (только внутри кириллического слова) ── */
    // Безопасно: трогаем латинскую букву-двойник лишь когда с обеих сторон кириллица,
    // т.е. внутри явно русского слова. Одиночные англ. буквы и англ. текст не страдают.
    var LAT2CYR = {
        a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у',
        A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х'
    };
    function fixHomoglyphs(t) {
        return t.replace(/(?<=[а-яёА-ЯЁ])([aceopxyABCEHKMOPTX])(?=[а-яёА-ЯЁ])/g, function (m) {
            return LAT2CYR[m] || m;
        });
    }

    /* ── PRE: сокращения и валюта ── */
    function fixAbbr(t) {
        var B = '(?<![а-яёА-ЯЁa-zA-Z])', A = '(?![а-яёА-ЯЁa-zA-Z])';
        var map = [
            ['и\\s*т\\.?\\s*д\\.?', 'и' + NBSP + 'т.' + NBSP + 'д.'],
            ['и\\s*т\\.?\\s*п\\.?', 'и' + NBSP + 'т.' + NBSP + 'п.'],
            ['и\\s*т\\.?\\s*к\\.?', 'и' + NBSP + 'т.' + NBSP + 'к.'],
            ['и\\s*др\\.?',         'и' + NBSP + 'др.'],
            ['т\\.?\\s*д\\.?',      'т.' + NBSP + 'д.'],
            ['т\\.?\\s*п\\.?',      'т.' + NBSP + 'п.'],
            ['т\\.?\\s*к\\.?',      'т.' + NBSP + 'к.'],
            ['т\\.?\\s*н\\.?',      'т.' + NBSP + 'н.'],
            ['т\\.?\\s*е\\.?',      'т.' + NBSP + 'е.']
        ];
        map.forEach(function (a) { t = t.replace(new RegExp(B + a[0] + A, 'gi'), a[1]); });
        return t;
    }

    function fixMoney(t) {
        // 500 руб / 500р / 1000 р. → 500 ₽
        t = t.replace(/(\d)\s*руб\.?(?![а-яёА-ЯЁa-zA-Z])/gi, '$1' + NBSP + '₽');
        t = t.replace(/(\d)\s*р\.?(?![а-яёА-ЯЁa-zA-Z])/gi, '$1' + NBSP + '₽');
        return t;
    }

    /* ── PRE: слившиеся местоимения/наречия с частицами -то/-либо/-нибудь ── */
    // «чтото» → «что-то», «ктонибудь» → «кто-нибудь» и т.д.
    // Паттерн: корень + суффикс слиплись без дефиса.
    function fixGluedParticles(t) {
        var roots = ['что', 'кто', 'как', 'где', 'куда', 'откуда', 'зачем', 'почему',
                     'отчего', 'чем', 'когда', 'сколько', 'какой', 'какая', 'какие',
                     'какого', 'каком', 'каким', 'которого', 'которому'];
        var suffs = ['то', 'либо', 'нибудь'];
        var B = '(?<![а-яёА-ЯЁ])';
        roots.forEach(function (r) {
            suffs.forEach(function (s) {
                t = t.replace(new RegExp(B + '(' + r + ')(' + s + ')(?![а-яёА-ЯЁ])', 'gi'),
                    function (m, a, b) { return a + '‑' + b; }); // NBH
            });
        });
        return t;
    }

    /* ── PRE: дефисные слова, которые движок не ловит (порядковые, по-...ски) ── */
    function fixSpacedHyphens(t) {
        var B = '(?<![а-яёА-ЯЁ])', A = '(?![а-яёА-ЯЁ])';
        var ord = [['во', 'первых'], ['во', 'вторых'], ['в', 'третьих'],
            ['в', 'четвёртых'], ['в', 'четвертых'], ['в', 'пятых'], ['в', 'шестых'],
            ['в', 'седьмых'], ['в', 'восьмых'], ['в', 'девятых'], ['в', 'десятых']];
        ord.forEach(function (o) {
            t = t.replace(new RegExp(B + '(' + o[0] + ')\\s+(' + o[1] + ')' + A, 'gi'), '$1-$2');
        });
        // по русски → по-русски (наречия на -ски/-цки/-ьи)
        t = t.replace(new RegExp(B + 'по\\s+([а-яё]+(?:ски|цки|ьи))' + A, 'gi'), 'по-$1');
        return t;
    }

    /* ── POST: капитализация (начало текста и после ! ? …) ── */
    // Точку намеренно НЕ трогаем: «т.д.», «5.5», «sample.ru» остаются как есть.
    function capitalize(t) {
        t = t.replace(/^(\s*[«„"(]?)([а-яёa-z])/, function (m, pre, l) { return pre + l.toUpperCase(); });
        t = t.replace(/([!?…]\s+[«„"(]?)([а-яёa-z])/g, function (m, pre, l) { return pre + l.toUpperCase(); });
        return t;
    }

    // Капс-строка целиком → нормальный регистр. Очень осторожно: только если это
    // похоже на фразу (≥3 слов и ≥12 букв), иначе аббревиатуры (ВВП, США) не трогаем.
    function fixCaps(t) {
        var letters = t.replace(/[^a-zA-ZА-ЯЁа-яё]/g, '');
        if (!letters.length || letters !== letters.toUpperCase()) return t;
        var words = t.split(/\s+/).filter(Boolean);
        if (words.length < 3 || letters.length < 12) return t;
        // Полностью в нижний регистр; заглавные в начале предложений вернёт capitalize().
        return t.toLowerCase();
    }

    /* ── POST: бренды (неразрывные внутри + правильный регистр) ── */
    var BRANDS = [
        'Яндекс Директ', 'Яндекс Метрика', 'Яндекс Маркет', 'Яндекс Музыка', 'Яндекс Карты',
        'Яндекс Погода', 'Яндекс Браузер', 'Яндекс Доставка', 'Яндекс Лавка', 'Яндекс Такси',
        'Яндекс Еда', 'Яндекс Плюс', 'Яндекс Диск', 'Яндекс Почта', 'Яндекс Афиша', 'Яндекс Кью',
        'VK Реклама', 'VK Видео', 'VK Музыка', 'VK Клипы', 'VK Pay',
        'Google Ads', 'Google Analytics', 'Google Chrome', 'Google Maps', 'Google Docs',
        'Google Drive', 'Google Sheets', 'Google Meet',
        'Apple Music', 'Apple Pay', 'Apple Watch', 'App Store', 'Play Market',
        'Telegram Premium', 'Сбер Pay', 'Тинькофф Банк', 'Альфа Банк',
        'Ozon Fresh', 'Ozon Premium', 'Mail ru', 'Mos ru'
    ];
    function fixBrands(t) {
        BRANDS.forEach(function (b) {
            var re = new RegExp(b.replace(/\s+/g, '[\\s' + NBSP + ']+'), 'gi');
            t = t.replace(re, b.replace(/ /g, NBSP));
        });
        return t;
    }
    function fixELama(t) {
        // Бренд несклоняемый: любые формы «елама/еламе/еламы…» → «еЛама».
        t = t.replace(/(?<![а-яёА-ЯЁa-zA-Z])[еЕ]лам[а-яё]*/g, 'еЛама');
        t = t.replace(/(?<![а-яёА-ЯЁa-zA-Z])[eE]lama(?![a-zA-Z])/gi, 'eLama');
        return t;
    }

    /* ── POST: частицы, которые движок не приклеил (конец строки и т.п.) ── */
    function fixParticles(t) {
        return t.replace(/(\S) (бы|ли|же|ль|ка)(?![а-яёА-ЯЁa-zA-Z])/gi, '$1' + NBSP + '$2');
    }

    /* ── Привести все неразрывные пробелы к одному виду (U+00A0) ── */
    function normalizeSpaces(t) {
        return t.replace(/[   ]/g, NBSP);
    }

    /* ── POST: неразрывный дефис только там, где он уместен ── */
    // Короткие приставки/частицы (из-за, по-новому, кто-то, что-нибудь) склеиваем NBH.
    // Длинные сложные слова (интернет-магазин) оставляем с обычным дефисом — пусть переносятся.
    function fixHyphen(t) {
        return t.replace(/([а-яёА-ЯЁ]+)-([а-яёА-ЯЁ]+)/g, function (m, l, r) {
            return (l.length <= 4 || r.length <= 4) ? l + NBH + r : m;
        });
    }

    /* ── Главная функция ── */
    function typografText(text) {
        if (!text || !text.trim()) return '';
        var store = [];
        text = mask(text, store);

        // PRE
        text = fixHomoglyphs(text);
        text = fixTypos(text);
        text = fixGluedParticles(text);
        text = fixSpacedHyphens(text);
        text = fixAbbr(text);
        text = fixMoney(text);

        // Движок (если по какой-то причине не загрузился — работаем со своим слоем)
        var tp = getEngine();
        if (tp) text = tp.execute(text);

        // POST
        text = fixCaps(text);
        text = capitalize(text);
        text = fixBrands(text);
        text = fixELama(text);
        text = fixParticles(text);
        text = fixHyphen(text);
        text = normalizeSpaces(text);

        text = unmask(text, store);
        return text.trim();
    }

    global.typografText = typografText;
    // для тестов в Node/JXA
    if (typeof module !== 'undefined' && module.exports) module.exports = { typografText: typografText, _engine: getEngine };
})(typeof globalThis !== 'undefined' ? globalThis : this);
