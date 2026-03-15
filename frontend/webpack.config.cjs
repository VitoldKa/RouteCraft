const path = require('path')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const MiniCssExtractPlugin = require('mini-css-extract-plugin')
const HtmlInlineCSSWebpackPlugin =
	require('html-inline-css-webpack-plugin').default
const JsonMinimizerPlugin = require('json-minimizer-webpack-plugin')
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin')

// development, production
module.exports = {
	entry: './src/webpack.js',
	devtool: 'source-map',
	output: {
		filename: 'index.[contenthash].js',
		sourceMapFilename: 'index.[contenthash].js.map',
		path: path.resolve(__dirname, '../backend/static'),
		clean: true,
	},
	resolve: {
		modules: [
			path.resolve(__dirname, 'src'), // dossier source
			'node_modules', // toujours garder celui-ci
		],
	},
	module: {
		rules: [
			{
				test: /\.css$/i,
				include: path.resolve(__dirname, 'src/components'),
				use: ['to-string-loader', 'css-loader'], // <-- renvoie du texte
			},
			{
				test: /\.css$/i,
				exclude: path.resolve(__dirname, 'src/components'),
				use: [MiniCssExtractPlugin.loader, 'css-loader'], // <-- garde les CSS globaux extraits
			},
		],
	},
	plugins: [
		new HtmlWebpackPlugin({
			template: './src/index.html',
			title: 'Lignes TPG',
		}),
		new CopyWebpackPlugin({
			patterns: [
				{
					from: path.resolve(__dirname, '../data/**/*.json'),
					to({ context, absoluteFilename }) {
						// Garde le même nom et le même dossier relatif
						const relPath = path.relative(
							path.resolve(__dirname, 'src'),
							absoluteFilename
						)
						return relPath
					},
					transform(content) {
						// 👇 Minifie le JSON avant de le copier
						return JSON.stringify(JSON.parse(content.toString()))
					},
				},
			],
		}),
		new MiniCssExtractPlugin({}),
		new HtmlInlineCSSWebpackPlugin(), // 👈 ajoute le CSS inline dans le HTML
	],
	optimization: {
		minimize: true,
		minimizer: [
			'...',
			new JsonMinimizerPlugin(),
			'...',
			new CssMinimizerPlugin(),
		],
	},
}
