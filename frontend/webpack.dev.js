// webpack.dev.js
const { merge } = require('webpack-merge')
const path = require('path')
const common = require('./webpack.common')

module.exports = merge(common, {
	mode: 'development',
	devtool: 'eval-source-map',

	module: {
		rules: [
			// CSS global → style-loader en dev
			{
				test: /\.css$/,
				exclude: path.resolve(__dirname, 'src/components'),
				use: ['style-loader', 'css-loader'],
			},
		],
	},

	devServer: {
		static: './dist',
		hot: true,
		watchFiles: ['src/**/*'],
	},
})
