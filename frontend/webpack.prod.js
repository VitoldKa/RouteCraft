// webpack.prod.js
const { merge } = require('webpack-merge')
const path = require('path')
const common = require('./webpack.common')

const MiniCssExtractPlugin = require('mini-css-extract-plugin')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin')
const JsonMinimizerPlugin = require('json-minimizer-webpack-plugin')
const HtmlInlineCSSWebpackPlugin =
	require('html-inline-css-webpack-plugin').default

module.exports = merge(common, {
	mode: 'production',
	devtool: 'source-map',

	module: {
		rules: [
			// En prod → MiniCssExtractPlugin pour CSS global
			{
				test: /\.css$/,
				exclude: path.resolve(__dirname, 'src/components'),
				use: [MiniCssExtractPlugin.loader, 'css-loader'],
			},
		],
	},

	plugins: [
		new MiniCssExtractPlugin({
			filename: 'styles.[contenthash].css',
		}),

		new HtmlInlineCSSWebpackPlugin(),
	],

	optimization: {
		minimize: true,
		minimizer: ['...', new CssMinimizerPlugin(), new JsonMinimizerPlugin()],
	},
})
