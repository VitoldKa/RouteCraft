// webpack.common.js
const path = require('path')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const DefinePlugin = require('webpack').DefinePlugin

module.exports = {
	entry: {
		index: './src/webpack.js',
		viewer: './src/viewer.js',
	},

	resolve: {
		modules: [path.resolve(__dirname, 'src'), 'node_modules'],
	},

	module: {
		rules: [
			// CSS pour composants → import dans JS
			{
				test: /\.css$/,
				include: path.resolve(__dirname, 'src/components'),
				use: ['to-string-loader', 'css-loader'],
			},

			// CSS global (ex: src/styles)
			{
				test: /\.css$/,
				exclude: path.resolve(__dirname, 'src/components'),
				use: ['css-loader'],
			},
		],
	},

	plugins: [
		new HtmlWebpackPlugin({
			template: './src/index.html',
			filename: 'index.html',
			chunks: ['index'],
			title: 'Lignes TPG',
		}),
		new HtmlWebpackPlugin({
			template: './src/viewer.html',
			filename: 'viewer.html',
			chunks: ['viewer'],
			title: 'OSM Route Viewer',
		}),
		new DefinePlugin({
			__APP_VERSION__: JSON.stringify(process.env.APP_VERSION || 'unknown'),
		}),
	],

	output: {
		filename: '[name].[contenthash].js',
		path: path.resolve(__dirname, '../backend/static'),
		clean: true,
	},
}
