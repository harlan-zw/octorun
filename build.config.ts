import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [{
    type: 'bundle',
    input: ['./src/index.ts', './src/cli.ts', './src/config.ts', './src/server.ts', './src/github.ts', './src/review.ts', './src/providers.ts'],
    dts: false,
  }],
  hooks: {
    rolldownOutput(output) {
      // Preparation can run below node_modules. Automatic chunks keep CLI startup out of library imports.
      output.codeSplitting = { groups: [] }
    },
  },
})
