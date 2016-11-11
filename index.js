function run() {
    var image = document.getElementById('background');
    image.onload = function() {
        var engine = new RainyDay({
            image: this
        });
        engine.rain([
            [0, 2, 100],
            [1, 1, 1]
        ], 200);
    };
    image.crossOrigin = 'anonymous';
    image.src = 'http://i.imgur.com/x86Mup0.jpg';
}
