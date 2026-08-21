// Tiny factory so the rest of the codebase never has to know the two
// matcher classes by name — it just asks for "the configured algorithm".
(function (VeilText) {
    'use strict';

    function createMatcher(algorithm, caseSensitive) {
        return algorithm === 'wumanber'
            ? new VeilText.Algorithms.WuManber(caseSensitive)
            : new VeilText.Algorithms.AhoCorasick(caseSensitive);
    }

    VeilText.Algorithms.createMatcher = createMatcher;
})(window.VeilText);
