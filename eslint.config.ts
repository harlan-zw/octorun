import antfu from '@antfu/eslint-config'

export default antfu({ typescript: true, ignores: ['.build/**', 'dist/**', 'coverage/**'] }, { rules: { 'node/prefer-global/process': 'off', 'node/prefer-global/buffer': 'off', 'ts/no-use-before-define': 'off', 'jsonc/sort-keys': 'off' } })
